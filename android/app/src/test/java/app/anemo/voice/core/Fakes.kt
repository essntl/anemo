package app.anemo.voice.core

/** Frames the fakes understand: the wake word, speech and silence. */
object Frames {
    const val WAKE: Short = 7_777
    const val SPEECH: Short = 1_000

    fun wake() = ShortArray(AudioFormat16k.FRAME_SAMPLES) { WAKE }
    fun speech() = ShortArray(AudioFormat16k.FRAME_SAMPLES) { SPEECH }
    fun silence() = ShortArray(AudioFormat16k.FRAME_SAMPLES)
}

class FakeWake : WakeWordDetector {
    var resets = 0
    override var lastScore = 0f
    override fun process(frame: ShortArray): Boolean {
        lastScore = if (frame[0] == Frames.WAKE) 0.83f else 0.01f
        return frame[0] == Frames.WAKE
    }
    override fun reset() {
        resets++
    }
}

/** Speech frames are speech, everything else is silence. */
class FakeVad : VoiceActivityDetector {
    override fun process(frame: ShortArray) = if (frame[0] == Frames.SPEECH) 0.9f else 0.05f
    override fun reset() = Unit
}

/** Records the cues by name: "start", "end", "timeout", "reply", "reopen", "voicemodeon", "voicemodeoff". */
class FakeChimes : Chimes {
    val played = mutableListOf<String>()
    override fun play(cue: Cue) {
        played += cue.name.lowercase()
    }
}

class FakeFocus : AudioFocus {
    var held = false
    var ducks = 0
    override fun duck() {
        held = true
        ducks++
    }

    override fun release() {
        held = false
    }
}

class FakeSpeaker : Speaker {
    val spoken = mutableListOf<String>()
    var stops = 0
    private var pending: ((Boolean) -> Unit)? = null
    val speaking: Boolean get() = pending != null

    override fun speak(text: String, onDone: (completed: Boolean) -> Unit) {
        check(pending == null) { "speaking twice at once" }
        spoken += text
        pending = onDone
    }

    override fun stop() {
        stops++
        val p = pending
        pending = null
        p?.invoke(false)
    }

    /** The speech engine finished the current text. */
    fun finish() {
        val p = checkNotNull(pending) { "nothing is being spoken" }
        pending = null
        p(true)
    }
}

/**
 * Records every call. A recording is first only transcribed: [heard] answers that at once
 * (null: the test answers [transcripts] itself), and the request then goes as text.
 */
class FakeBackend : VoiceBackend {
    data class Turn(
        val wav: ByteArray?,
        val conversationId: String?,
        val status: Boolean,
        val onResult: (TurnResult) -> Unit,
        val text: String? = null,
        val voiceMode: Boolean = false,
        val keepChat: Boolean = false,
    )
    data class Reply(val wav: ByteArray, val approvalId: String, val onResult: (ReplyResult) -> Unit)
    data class Transcript(val wav: ByteArray, val onResult: (TranscriptResult) -> Unit)

    var heard: String? = "uh mail tom no tim"
    val turns = mutableListOf<Turn>()
    val replies = mutableListOf<Reply>()
    val transcripts = mutableListOf<Transcript>()

    override fun sendTurn(wav: ByteArray?, conversationId: String?, status: Boolean, onResult: (TurnResult) -> Unit) {
        turns += Turn(wav, conversationId, status, onResult)
    }

    override fun transcribe(wav: ByteArray, onResult: (TranscriptResult) -> Unit) {
        transcripts += Transcript(wav, onResult)
        heard?.let { onResult(TranscriptResult.Heard(it)) }
    }

    override fun sendText(
        text: String,
        conversationId: String?,
        voiceMode: Boolean,
        keepChat: Boolean,
        onResult: (TurnResult) -> Unit,
    ) {
        turns += Turn(null, conversationId, false, onResult, text, voiceMode, keepChat)
    }

    override fun sendReply(wav: ByteArray, approvalId: String, onResult: (ReplyResult) -> Unit) {
        replies += Reply(wav, approvalId, onResult)
    }
}

class MemoryHistory : HistoryStore {
    val entries = mutableListOf<HistoryEntry>()

    override fun add(entry: HistoryEntry) {
        entries.add(0, entry)
        while (entries.size > HistoryStore.LIMIT) entries.removeAt(entries.lastIndex)
    }

    override fun setAnswer(runId: String, answer: String) {
        val i = entries.indexOfFirst { it.runId == runId }
        if (i >= 0) entries[i] = entries[i].copy(answer = answer)
    }

    override fun recent(): List<HistoryEntry> = entries.toList()
}

class FakeClock(var now: Long = 1_000_000) : Clock {
    override fun nowMillis() = now
}

/** Time that moves only when the test says so; due actions run then. */
class FakeTimer : Timer {
    private class Task(val at: Long, val action: () -> Unit) {
        var cancelled = false
    }

    var now = 0L
        private set
    private val tasks = mutableListOf<Task>()

    override fun schedule(delayMs: Long, action: () -> Unit): Cancellable {
        val t = Task(now + delayMs, action)
        tasks += t
        return Cancellable { t.cancelled = true }
    }

    val pending: Int get() = tasks.count { !it.cancelled }

    fun advance(ms: Long) {
        now += ms
        while (true) {
            val due = tasks.filter { !it.cancelled && it.at <= now }.minByOrNull { it.at } ?: return
            tasks.remove(due)
            due.action()
        }
    }
}
