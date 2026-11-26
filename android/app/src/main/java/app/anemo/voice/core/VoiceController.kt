package app.anemo.voice.core

/** What the phone is doing, for the notification and the app. */
enum class ListenState { Stopped, Paused, Listening, Recording, Speaking }

/**
 * The listen → record → upload → speak → reply loop, and voice mode on top of it. Not
 * thread-safe: every method is called on one thread (the service's voice thread; the
 * test's thread in tests).
 *
 * Only these are ever uploaded: a recording that followed the wake word, a recording made
 * in voice mode (which only the user turns on, on the phone), a reply the app asked for
 * (after speaking a question, an approval or a plan), and the status command. Recordings
 * live in memory only.
 *
 * A request is first only transcribed (`/voice/transcripts`); the phone checks whether it
 * was a voice-mode command ([Commands]) and otherwise sends it on as text. So the voice-mode
 * commands are matched here, in plain code, on what the user said, and nothing a run
 * writes can switch voice mode or open the microphone (docs/specs/07-voice-mode-android.md).
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
    private val focus: AudioFocus = AudioFocus.None,
    private val options: Options = Options(),
) {
    interface Listener {
        fun onStateChanged(state: ListenState) {}
        fun onHistoryChanged() {}
        fun onActiveRunsChanged(count: Int) {}

        /** The wake word was detected with this score (for the log). */
        fun onWakeWord(score: Float) {}

        /** Voice mode went on or off (for the log, the notification and the server's audit log). */
        fun onVoiceModeChanged(on: Boolean, cause: VoiceModeCause) {}
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
        /** Frames up to and with the one the wake word fired on that go into the recording (160 ms). */
        val preRollFrames: Int = 2,
        /** Frames not recorded when voice mode opens the microphone (240 ms): the cue and the speaker's echo. */
        val reopenSkipFrames: Int = 3,
    )

    /** The user's voice-mode settings. */
    data class Options(
        /** The wake word as it is spoken ("Hey Jarvis"), removed from the start of a request. */
        val wakeWord: String = "Hey Jarvis",
        /** "Say “start voice mode” to turn it on". */
        val startPhrase: Boolean = true,
        /** Voice mode ends when nobody speaks this long after the microphone opened. */
        val voiceModeIdleMs: Int = 45_000,
    )

    private sealed interface Purpose {
        /** After the wake word. */
        data object Request : Purpose

        /** Voice mode opened the microphone (no wake word). */
        data object VoiceModeRequest : Purpose
        data class Reply(val approval: Approval, val attempt: Int) : Purpose
    }

    /** What happens once something has been said. */
    private sealed interface Then {
        data object Nothing : Then

        /** Voice mode: open the microphone again (if it is still the same session). */
        data class Reopen(val session: Int) : Then

        /** Voice mode: the agent ended it (`voice_stop`). */
        data class EndVoiceMode(val session: Int) : Then
    }

    private sealed interface Utterance {
        val text: String

        data class Say(override val text: String, val then: Then = Then.Nothing) : Utterance
        data class Ask(val approval: Approval, override val text: String, val attempt: Int) : Utterance
    }

    private sealed interface Mode {
        data object Stopped : Mode
        data object Paused : Mode
        data object Waiting : Mode
        class Recording(val purpose: Purpose, val buffer: RecordingBuffer, val endpointer: Endpointer, var skip: Int) : Mode
        class Speaking(val item: Utterance) : Mode
    }

    private var mode: Mode = Mode.Stopped
    private var watchdog: Cancellable? = null
    private val queue = ArrayDeque<Utterance>()
    private val replyBudget = ReplyBudget(monotonic)

    /** The last frames heard while waiting: the start of a request said right after the wake word. */
    private val recent = ArrayDeque<ShortArray>()

    private val voiceMode = VoiceMode()

    /** Voice mode: the session whose microphone should open as soon as nothing else is said. */
    private var reopenFor: Int? = null

    /** The first opening after voice mode went on has no cue of its own: the "on" sound was it. */
    private var silentReopen = false

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

    val voiceModeOn: Boolean get() = voiceMode.on

    // --- lifecycle -------------------------------------------------------------------

    fun start() {
        if (mode != Mode.Stopped && mode != Mode.Paused) return
        wake.reset()
        recent.clear()
        setMode(Mode.Waiting)
        pump()
    }

    fun pause() {
        if (mode == Mode.Stopped) return
        leaveVoiceMode(VoiceModeCause.ServiceStopped)
        setMode(Mode.Paused) // first, so the stopped speech doesn't move on
        speaker.stop()
    }

    fun resume() {
        if (mode == Mode.Paused) start()
    }

    fun stop() {
        leaveVoiceMode(VoiceModeCause.ServiceStopped)
        queue.clear()
        setMode(Mode.Stopped)
        speaker.stop()
    }

    // --- voice mode ------------------------------------------------------------------

    /** The tile or the notification switched voice mode. Ignored while paused or stopped. */
    fun setVoiceMode(on: Boolean, cause: VoiceModeCause) {
        if (on) enterVoiceMode(cause) else leaveVoiceMode(cause)
    }

    /**
     * [openMicrophone]: open it as soon as nothing else is being said. Not when the tile is
     * tapped while a request is being recorded: that request goes on, is sent in voice
     * mode, and its answer opens the microphone.
     */
    private fun enterVoiceMode(
        cause: VoiceModeCause,
        openMicrophone: Boolean = (mode as? Mode.Recording)?.purpose != Purpose.Request,
    ) {
        if (mode == Mode.Stopped || mode == Mode.Paused) return
        if (!voiceMode.turnOn()) return
        listener.onVoiceModeChanged(true, cause)
        chimes.play(Cue.VoiceModeOn)
        if (openMicrophone) {
            reopenFor = voiceMode.session
            silentReopen = true
            pump()
        }
    }

    /** Every way out: the tile, the notification, "stop", the idle timeout, `voice_stop`, pause and stop. */
    private fun leaveVoiceMode(cause: VoiceModeCause) {
        if (!voiceMode.turnOff()) return
        reopenFor = null
        silentReopen = false
        listener.onVoiceModeChanged(false, cause)
        chimes.play(Cue.VoiceModeOff)
        val m = mode
        if (m is Mode.Recording && m.purpose == Purpose.VoiceModeRequest) {
            m.buffer.clear() // what voice mode was recording is thrown away
            backToWaiting()
        }
    }

    /** Opens the microphone for voice mode when it is due and nothing else is going on. */
    private fun reopenIfDue() {
        val due = reopenFor ?: return
        if (mode != Mode.Waiting || queue.isNotEmpty()) return
        reopenFor = null
        if (!voiceMode.current(due)) return
        startRecording(Purpose.VoiceModeRequest, cue = if (silentReopen) null else Cue.Reopen)
        silentReopen = false
    }

    // --- audio -----------------------------------------------------------------------

    /** One 80 ms frame from the microphone. */
    fun onFrame(frame: ShortArray) {
        when (val m = mode) {
            Mode.Waiting -> {
                recent.addLast(frame)
                while (recent.size > timing.preRollFrames) recent.removeFirst()
                if (wake.process(frame)) onWakeWord()
            }
            is Mode.Recording -> record(m, frame)
            else -> Unit // not listening, or speaking (never hear ourselves)
        }
    }

    /** Duck, cue, record from here on (with the frames just before), log: all before the next frame. */
    private fun onWakeWord() {
        val preRoll = recent.toList()
        recent.clear()
        val recording = startRecording(Purpose.Request, Cue.Start)
        preRoll.forEach(recording.buffer::add) // not given to the end-of-speech detector: it's the wake word
        listener.onWakeWord(wake.lastScore)
    }

    private fun startRecording(purpose: Purpose, cue: Cue?): Mode.Recording {
        val endpointer = when (purpose) {
            is Purpose.Reply -> Endpointer(
                silenceMs = timing.silenceMs,
                maxMs = timing.replyNoSpeechMs + timing.maxReplyMs,
                maxSpeechMs = timing.maxReplyMs,
                noSpeechMs = timing.replyNoSpeechMs,
            )
            Purpose.VoiceModeRequest -> Endpointer(
                silenceMs = timing.silenceMs,
                maxMs = options.voiceModeIdleMs + timing.maxRecordingMs,
                maxSpeechMs = timing.maxRecordingMs,
                noSpeechMs = options.voiceModeIdleMs,
            )
            Purpose.Request -> Endpointer(
                silenceMs = timing.silenceMs,
                maxMs = timing.maxRecordingMs,
                noSpeechMs = timing.requestNoSpeechMs,
            )
        }
        val preRollSamples = if (purpose == Purpose.Request) timing.preRollFrames * AudioFormat16k.FRAME_SAMPLES else 0
        val maxSamples = AudioFormat16k.SAMPLE_RATE / 1000 * endpointer.maxTotalMs + preRollSamples
        vad.reset()
        focus.duck()
        cue?.let(chimes::play)
        val skip = if (purpose == Purpose.VoiceModeRequest) timing.reopenSkipFrames else 0
        val recording = Mode.Recording(purpose, RecordingBuffer(maxSamples), endpointer, skip)
        setMode(recording)
        // frames stop coming (microphone gone): don't stay "recording" for ever
        guard(recording, endpointer.maxTotalMs + timing.recordingGraceMs) {
            chimes.play(Cue.End)
            recording.buffer.clear()
            backToWaiting()
        }
        return recording
    }

    private fun record(m: Mode.Recording, frame: ShortArray) {
        if (m.skip > 0) {
            m.skip--
            return
        }
        m.buffer.add(frame)
        when (m.endpointer.update(vad.process(frame))) {
            Endpointer.Result.Continue -> Unit
            Endpointer.Result.NoSpeech -> when (m.purpose) {
                // the idle timeout: leaving throws the recording away and plays its own sound
                Purpose.VoiceModeRequest -> leaveVoiceMode(VoiceModeCause.Timeout)
                Purpose.Request, is Purpose.Reply -> {
                    // the wake word was heard, but nobody spoke after it
                    chimes.play(if (m.purpose == Purpose.Request) Cue.Timeout else Cue.End)
                    m.buffer.clear()
                    backToWaiting()
                }
            }
            Endpointer.Result.End -> {
                chimes.play(Cue.End)
                val wav = Wav.encode(m.buffer.samples())
                m.buffer.clear()
                upload(m.purpose, wav)
                backToWaiting()
            }
        }
    }

    private fun upload(purpose: Purpose, wav: ByteArray) {
        when (purpose) {
            Purpose.Request, Purpose.VoiceModeRequest -> {
                val session = voiceMode.session
                backend.transcribe(wav) { onTranscript(it, wav, session) }
            }
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

    /** What was heard: a voice-mode command, or a request to send on as text. */
    private fun onTranscript(result: TranscriptResult, wav: ByteArray, session: Int) {
        val reopen = reopenAfter(session)
        when (result) {
            is TranscriptResult.Heard -> onHeard(result.text, session)
            is TranscriptResult.Say -> say(result.text, reopen)
            is TranscriptResult.Unauthorized -> say(Phrases.UNAUTHORIZED, reopen)
            // An Anemo older than this app has no /voice/transcripts: the request goes as
            // a recording, as before (no voice-mode commands then).
            is TranscriptResult.Refused -> if (result.error.httpStatus == 404) {
                backend.sendTurn(wav, lastConversation, status = false) { onTurnResult(it, session) }
            } else {
                say(Phrases.refused(result.error), reopen)
            }
            TranscriptResult.Unreachable -> say(Phrases.UNREACHABLE, reopen)
        }
    }

    private fun onHeard(heard: String, session: Int) {
        when (Commands.match(heard, options.wakeWord, voiceMode.on, options.startPhrase)) {
            Command.StartVoiceMode -> if (voiceMode.on) {
                reopenFor = voiceMode.session // already on: just listen again
                pump()
            } else {
                enterVoiceMode(VoiceModeCause.Phrase, openMicrophone = true)
            }
            Command.StopVoiceMode -> leaveVoiceMode(VoiceModeCause.StopPhrase)
            null -> {
                val request = Commands.request(heard, options.wakeWord)
                if (request.isBlank()) {
                    say(Phrases.NOT_HEARD, reopenAfter(session))
                    return
                }
                // Sent in voice mode if it is on now (also when it went on while recording).
                val inVoiceMode = voiceMode.on
                val now = voiceMode.session
                val keepChat = inVoiceMode && voiceMode.requestSent()
                backend.sendText(request, lastConversation, inVoiceMode, keepChat) { onTurnResult(it, now) }
            }
        }
    }

    fun onTurnResult(result: TurnResult) = onTurnResult(result, session = 0)

    private fun onTurnResult(result: TurnResult, session: Int) {
        val reopen = reopenAfter(session)
        when (result) {
            is TurnResult.Started -> {
                voiceMode.started(result.runId, session)
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
            TurnResult.Cancelled -> after(reopen)
            is TurnResult.Say -> say(result.text, reopen)
            is TurnResult.Unauthorized -> say(Phrases.UNAUTHORIZED, reopen)
            is TurnResult.Refused -> say(Phrases.refused(result.error), reopen)
            TurnResult.Unreachable -> say(Phrases.UNREACHABLE, reopen)
        }
    }

    /** Voice mode: after the phone's own answer to a request of [session], listen again. */
    private fun reopenAfter(session: Int): Then =
        if (voiceMode.current(session)) Then.Reopen(session) else Then.Nothing

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
                val then = when (voiceMode.answered(event.runId)) {
                    VoiceMode.After.Nothing -> Then.Nothing
                    VoiceMode.After.Reopen -> Then.Reopen(voiceMode.session)
                    VoiceMode.After.End -> Then.EndVoiceMode(voiceMode.session)
                }
                say(event.text, then)
            }
            // Only ever ends voice mode, and only after that run's answer was spoken.
            is DeviceEvent.VoiceStop -> voiceMode.stopAfter(event.runId)
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
                chimes.play(Cue.End)
                m.buffer.clear()
                backToWaiting()
            }
            else -> Unit
        }
    }

    // --- speaking --------------------------------------------------------------------

    private fun say(text: String, then: Then = Then.Nothing) {
        if (text.isNotBlank()) enqueue(Utterance.Say(text, then)) else after(then)
    }

    private fun enqueue(item: Utterance) {
        if (mode == Mode.Stopped) return
        queue.addLast(item)
        pump()
    }

    /** Speaks the next queued item when the phone isn't recording or speaking; else voice mode may listen. */
    private fun pump() {
        if (mode != Mode.Waiting) return
        val item = queue.removeFirstOrNull()
        if (item == null) {
            reopenIfDue()
            return
        }
        val speaking = Mode.Speaking(item)
        setMode(speaking)
        // the speech engine never reports back: give up on it rather than hang
        guard(speaking, timing.speakingBaseMs + timing.speakingPerCharMs * item.text.length) {
            setMode(Mode.Waiting)
            speaker.stop()
            if (item is Utterance.Say) after(item.then)
            backToWaiting()
        }
        speaker.speak(item.text) { completed -> onSpoken(speaking, completed) }
    }

    private fun onSpoken(speaking: Mode.Speaking, completed: Boolean) {
        if (mode !== speaking) return // stopped, paused or decided meanwhile
        val item = speaking.item
        when {
            item is Utterance.Say -> {
                after(item.then)
                backToWaiting()
            }
            item !is Utterance.Ask -> backToWaiting()
            !completed || item.approval.id in decidedApprovals -> backToWaiting()
            item.text.isBlank() -> backToWaiting()
            replyBudget.take(item.approval.runId) -> startRecording(Purpose.Reply(item.approval, item.attempt), Cue.Reply)
            else -> {
                backToWaiting()
                say(Phrases.USE_NOTIFICATION)
            }
        }
    }

    /** What voice mode does once something was said (or there was nothing to say). */
    private fun after(then: Then) {
        when (then) {
            Then.Nothing -> Unit
            is Then.Reopen -> if (voiceMode.current(then.session)) {
                reopenFor = then.session
                pump()
            }
            is Then.EndVoiceMode -> if (voiceMode.current(then.session)) leaveVoiceMode(VoiceModeCause.VoiceStop)
        }
    }

    private fun backToWaiting() {
        wake.reset()
        recent.clear()
        setMode(Mode.Waiting)
        pump()
    }

    private fun setMode(m: Mode) {
        watchdog?.cancel()
        watchdog = null
        if (mode is Mode.Recording && m !is Mode.Recording) focus.release()
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
