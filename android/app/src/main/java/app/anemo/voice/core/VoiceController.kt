package app.anemo.voice.core

/** What the phone is doing, for the notification and the app. */
enum class ListenState { Stopped, Paused, Listening, Recording, Speaking }

/**
 * The listen → record → upload → speak → reply loop. Not thread-safe: every method is
 * called on one thread (the service's voice thread; the test's thread in tests).
 *
 * Only three things are ever uploaded: a recording that followed the wake word, a reply
 * the app asked for (after speaking a question, an approval or a plan), and the status
 * command. Recordings live in memory only.
 */
class VoiceController(
    private val wake: WakeWordDetector,
    private val vad: VoiceActivityDetector,
    private val chimes: Chimes,
    private val speaker: Speaker,
    private val backend: VoiceBackend,
    private val history: HistoryStore,
    /** Wall-clock time, for the history. */
    private val clock: Clock,
    /** Monotonic time (`SystemClock.elapsedRealtime`), for the reply budget. */
    private val monotonic: Clock,
    private val timer: Timer,
    private val chatLink: (conversationId: String) -> String,
    private val listener: Listener = object : Listener {},
    private val timing: Timing = Timing(),
) {
    interface Listener {
        fun onStateChanged(state: ListenState) {}
        fun onHistoryChanged() {}
        fun onActiveRunsChanged(count: Int) {}
    }

    data class Timing(
        val silenceMs: Int = 1_000,
        val maxRecordingMs: Int = 60_000,
        val requestNoSpeechMs: Int = 5_000,
        /** How long the phone waits for a reply to begin. */
        val replyNoSpeechMs: Int = 8_000,
        /** How long a reply may last once it began. */
        val maxReplyMs: Int = 15_000,
        /** Extra time before a recording that gets no frames is given up (microphone dead). */
        val recordingGraceMs: Long = 3_000,
        /** Speech that never reports back is given up after this plus [speakingPerCharMs] a character. */
        val speakingBaseMs: Long = 20_000,
        val speakingPerCharMs: Long = 120,
    )

    private sealed interface Purpose {
        data object Request : Purpose
        data class Reply(val approval: Approval, val attempt: Int) : Purpose
    }

    private sealed interface Utterance {
        val text: String

        data class Say(override val text: String) : Utterance
        data class Ask(val approval: Approval, override val text: String, val attempt: Int) : Utterance
    }

    private sealed interface Mode {
        data object Stopped : Mode
        data object Paused : Mode
        data object Waiting : Mode
        class Recording(val purpose: Purpose, val buffer: RecordingBuffer, val endpointer: Endpointer) : Mode
        class Speaking(val item: Utterance) : Mode
    }

    private var mode: Mode = Mode.Stopped
    private var watchdog: Cancellable? = null
    private val queue = ArrayDeque<Utterance>()
    private val replyBudget = ReplyBudget(monotonic)

    /**
     * The chat of the last answer: every new request asks to continue it, and the server
     * decides by its own follow-up window (Settings → Voice) whether it does.
     */
    private var lastConversation: String? = null
    private val seenApprovals = LinkedHashSet<String>()
    private val decidedApprovals = LinkedHashSet<String>()
    private val activeRuns = HashMap<String, String>()

    val state: ListenState
        get() = when (mode) {
            Mode.Stopped -> ListenState.Stopped
            Mode.Paused -> ListenState.Paused
            Mode.Waiting -> ListenState.Listening
            is Mode.Recording -> ListenState.Recording
            is Mode.Speaking -> ListenState.Speaking
        }

    // --- lifecycle -------------------------------------------------------------------

    fun start() {
        if (mode != Mode.Stopped && mode != Mode.Paused) return
        wake.reset()
        setMode(Mode.Waiting)
        pump()
    }

    fun pause() {
        if (mode == Mode.Stopped) return
        setMode(Mode.Paused) // first, so the stopped speech doesn't move on
        speaker.stop()
    }

    fun resume() {
        if (mode == Mode.Paused) start()
    }

    fun stop() {
        queue.clear()
        setMode(Mode.Stopped)
        speaker.stop()
    }

    // --- audio -----------------------------------------------------------------------

    /** One 80 ms frame from the microphone. */
    fun onFrame(frame: ShortArray) {
        when (val m = mode) {
            Mode.Waiting -> if (wake.process(frame)) startRecording(Purpose.Request)
            is Mode.Recording -> record(m, frame)
            else -> Unit // not listening, or speaking (never hear ourselves)
        }
    }

    private fun startRecording(purpose: Purpose) {
        val endpointer = if (purpose is Purpose.Reply) {
            Endpointer(
                silenceMs = timing.silenceMs,
                maxMs = timing.replyNoSpeechMs + timing.maxReplyMs,
                maxSpeechMs = timing.maxReplyMs,
                noSpeechMs = timing.replyNoSpeechMs,
            )
        } else {
            Endpointer(silenceMs = timing.silenceMs, maxMs = timing.maxRecordingMs, noSpeechMs = timing.requestNoSpeechMs)
        }
        val maxSamples = AudioFormat16k.SAMPLE_RATE / 1000 * endpointer.maxTotalMs
        vad.reset()
        if (purpose is Purpose.Reply) chimes.reply() else chimes.start()
        val recording = Mode.Recording(purpose, RecordingBuffer(maxSamples), endpointer)
        setMode(recording)
        // frames stop coming (microphone gone): don't stay "recording" for ever
        guard(recording, endpointer.maxTotalMs + timing.recordingGraceMs) {
            chimes.stop()
            recording.buffer.clear()
            backToWaiting()
        }
    }

    private fun record(m: Mode.Recording, frame: ShortArray) {
        m.buffer.add(frame)
        when (m.endpointer.update(vad.process(frame))) {
            Endpointer.Result.Continue -> Unit
            Endpointer.Result.NoSpeech -> {
                chimes.stop()
                m.buffer.clear()
                backToWaiting()
            }
            Endpointer.Result.End -> {
                chimes.stop()
                val wav = Wav.encode(m.buffer.samples())
                m.buffer.clear()
                upload(m.purpose, wav)
                backToWaiting()
            }
        }
    }

    private fun upload(purpose: Purpose, wav: ByteArray) {
        when (purpose) {
            Purpose.Request ->
                backend.sendTurn(wav, lastConversation, status = false, ::onTurnResult)
            is Purpose.Reply ->
                backend.sendReply(wav, purpose.approval.id) { onReplyResult(purpose, it) }
        }
    }

    /** The status command: asks Anemo what is running. No audio is sent. */
    fun requestStatus() {
        if (mode == Mode.Stopped) return
        backend.sendTurn(wav = null, conversationId = null, status = true, ::onTurnResult)
    }

    // --- answers from the REST calls -------------------------------------------------

    fun onTurnResult(result: TurnResult) {
        when (result) {
            is TurnResult.Started -> {
                history.add(
                    HistoryEntry(
                        runId = result.runId,
                        conversationId = result.conversationId.orEmpty(),
                        heard = result.heard,
                        request = result.request,
                        answer = null,
                        chatLink = result.conversationId?.let(chatLink).orEmpty(),
                        createdAt = clock.nowMillis(),
                    ),
                )
                listener.onHistoryChanged()
            }
            TurnResult.Cancelled -> Unit
            is TurnResult.Say -> say(result.text)
            is TurnResult.Unauthorized -> say(Phrases.UNAUTHORIZED)
            is TurnResult.Refused -> say(Phrases.refused(result.error))
            TurnResult.Unreachable -> say(Phrases.UNREACHABLE)
        }
    }

    private fun onReplyResult(purpose: Purpose.Reply, result: ReplyResult) {
        val approval = purpose.approval
        when (result) {
            is ReplyResult.Decided -> {
                markDecided(approval.id)
                result.say?.let(::say)
            }
            is ReplyResult.Unclear -> when {
                approval.id in decidedApprovals -> Unit
                purpose.attempt == 1 -> enqueue(Utterance.Ask(approval, result.say, attempt = 2))
                else -> say(Phrases.USE_NOTIFICATION)
            }
            ReplyResult.NeedsTap -> say(Phrases.NEEDS_TAP)
            ReplyResult.AlreadyDecided -> markDecided(approval.id)
            is ReplyResult.Unauthorized -> say(Phrases.UNAUTHORIZED)
            is ReplyResult.Refused -> say("${Phrases.refused(result.error)} ${Phrases.USE_NOTIFICATION}")
            ReplyResult.Unreachable -> say("${Phrases.UNREACHABLE} ${Phrases.USE_NOTIFICATION}")
        }
    }

    // --- events from the WebSocket ---------------------------------------------------

    fun onEvent(event: DeviceEvent) {
        when (event) {
            is DeviceEvent.RunStatus -> {
                if (event.status in TERMINAL) activeRuns.remove(event.runId) else activeRuns[event.runId] = event.status
                listener.onActiveRunsChanged(activeRuns.size)
            }
            is DeviceEvent.VoiceSay -> {
                activeRuns.remove(event.runId)
                listener.onActiveRunsChanged(activeRuns.size)
                event.conversationId?.let { lastConversation = it }
                history.setAnswer(event.runId, event.text)
                listener.onHistoryChanged()
                say(event.text)
            }
            is DeviceEvent.ApprovalRequested -> onApproval(event.approval)
            is DeviceEvent.ApprovalDecided -> markDecided(event.approvalId)
        }
    }

    private fun onApproval(approval: Approval) {
        if (approval.id in decidedApprovals || !remember(seenApprovals, approval.id)) return
        if (approval.dangerous) {
            say(Phrases.dangerous(approval))
        } else if (Phrases.nothingToRead(approval)) {
            say(Phrases.NOTHING_TO_READ) // never listen after saying nothing
        } else {
            enqueue(Utterance.Ask(approval, Phrases.ask(approval), attempt = 1))
        }
    }

    /** Decided here or elsewhere: stop asking about it. */
    private fun markDecided(approvalId: String) {
        remember(decidedApprovals, approvalId)
        queue.removeAll { it is Utterance.Ask && it.approval.id == approvalId }
        when (val m = mode) {
            is Mode.Speaking -> if ((m.item as? Utterance.Ask)?.approval?.id == approvalId) {
                setMode(Mode.Waiting) // first, so the stopped speech doesn't start a reply
                speaker.stop()
                backToWaiting()
            }
            is Mode.Recording -> if ((m.purpose as? Purpose.Reply)?.approval?.id == approvalId) {
                chimes.stop()
                m.buffer.clear()
                backToWaiting()
            }
            else -> Unit
        }
    }

    // --- speaking --------------------------------------------------------------------

    private fun say(text: String) {
        if (text.isNotBlank()) enqueue(Utterance.Say(text))
    }

    private fun enqueue(item: Utterance) {
        if (mode == Mode.Stopped) return
        queue.addLast(item)
        pump()
    }

    /** Speaks the next queued item when the phone isn't recording or speaking. */
    private fun pump() {
        if (mode != Mode.Waiting) return
        val item = queue.removeFirstOrNull() ?: return
        val speaking = Mode.Speaking(item)
        setMode(speaking)
        // the speech engine never reports back: give up on it rather than hang
        guard(speaking, timing.speakingBaseMs + timing.speakingPerCharMs * item.text.length) {
            setMode(Mode.Waiting)
            speaker.stop()
            backToWaiting()
        }
        speaker.speak(item.text) { completed -> onSpoken(speaking, completed) }
    }

    private fun onSpoken(speaking: Mode.Speaking, completed: Boolean) {
        if (mode !== speaking) return // stopped, paused or decided meanwhile
        val item = speaking.item
        when {
            !completed || item !is Utterance.Ask || item.approval.id in decidedApprovals -> backToWaiting()
            item.text.isBlank() -> backToWaiting()
            replyBudget.take(item.approval.runId) -> startRecording(Purpose.Reply(item.approval, item.attempt))
            else -> {
                backToWaiting()
                say(Phrases.USE_NOTIFICATION)
            }
        }
    }

    private fun backToWaiting() {
        wake.reset()
        setMode(Mode.Waiting)
        pump()
    }

    private fun setMode(m: Mode) {
        watchdog?.cancel()
        watchdog = null
        val before = state
        mode = m
        if (state != before) listener.onStateChanged(state)
    }

    /** Runs [onTimeout] after [ms] if the phone is still in [m] then. */
    private fun guard(m: Mode, ms: Long, onTimeout: () -> Unit) {
        watchdog = timer.schedule(ms) { if (mode === m) onTimeout() }
    }

    private fun remember(set: LinkedHashSet<String>, id: String): Boolean {
        val added = set.add(id)
        if (set.size > REMEMBERED) set.remove(set.first())
        return added
    }

    companion object {
        private const val REMEMBERED = 200
        private val TERMINAL = setOf("completed", "failed", "cancelled")
    }
}
