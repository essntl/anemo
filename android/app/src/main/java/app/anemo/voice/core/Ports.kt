package app.anemo.voice.core

/**
 * The platform behind the voice logic. Android implements these in `audio/`, `ml/`,
 * `history/` and `net/`; tests use fakes. Callbacks may arrive on any thread: the
 * Android wiring posts them back to the controller's thread before calling it.
 */

/** Wake word engine: fed 80 ms frames (1280 samples), says when it heard the word. */
interface WakeWordDetector {
    fun process(frame: ShortArray): Boolean
    fun reset()

    /** The score of the last frame (0..1), logged with each detection. */
    val lastScore: Float get() = 0f
}

/** Voice activity: speech probability (0..1) of an 80 ms frame. */
interface VoiceActivityDetector {
    fun process(frame: ShortArray): Float
    fun reset()
}

/**
 * The short sounds (and buzz) that say "I heard you", "I stopped", "voice mode is on"….
 * The optional ones ([Cue.optional]) may be switched off in the settings; the others
 * always play, so the microphone never opens without a wake word unannounced.
 */
fun interface Chimes {
    fun play(cue: Cue)
}

/**
 * Other apps' sound while the phone records: [duck] asks them to get quiet (transient
 * audio focus, may duck), [release] gives the focus back.
 */
interface AudioFocus {
    fun duck()
    fun release()

    /** No audio focus (tests, and phones where asking fails). */
    object None : AudioFocus {
        override fun duck() = Unit
        override fun release() = Unit
    }
}

/** Text to speech. [onDone] gets true when the text was spoken to the end. */
interface Speaker {
    fun speak(text: String, onDone: (completed: Boolean) -> Unit)
    fun stop()
}

/** Anemo's voice REST (device-contracts.md §4). */
interface VoiceBackend {
    /**
     * A request ([status] false, with its recording) or the status command ([status] true,
     * [wav] null: no audio is sent). [conversationId] asks to continue that chat; the server
     * decides whether it is still within its follow-up window.
     */
    fun sendTurn(wav: ByteArray?, conversationId: String?, status: Boolean, onResult: (TurnResult) -> Unit)

    fun sendReply(wav: ByteArray, approvalId: String, onResult: (ReplyResult) -> Unit)

    /** Only transcribes a recording (`/voice/transcripts`): nothing starts on the server. */
    fun transcribe(wav: ByteArray, onResult: (TranscriptResult) -> Unit)

    /**
     * A request as text, the transcript [transcribe] gave (`/voice/turns` with `text`).
     * [voiceMode]: the phone listens again after the answer; [keepChat]: stay in
     * [conversationId] whatever the follow-up window says.
     */
    fun sendText(
        text: String,
        conversationId: String?,
        voiceMode: Boolean,
        keepChat: Boolean,
        onResult: (TurnResult) -> Unit,
    )
}

/** One request in the app's history (the only thing the app keeps of a request). */
data class HistoryEntry(
    val runId: String,
    val conversationId: String,
    val heard: String,
    val request: String,
    val answer: String?,
    val chatLink: String,
    val createdAt: Long,
)

interface HistoryStore {
    /** Adds an entry and keeps only the newest [LIMIT]. */
    fun add(entry: HistoryEntry)
    fun setAnswer(runId: String, answer: String)
    fun recent(): List<HistoryEntry>

    companion object {
        const val LIMIT = 50
    }
}

fun interface Clock {
    fun nowMillis(): Long
}

/** Runs something later on the controller's thread. */
fun interface Timer {
    fun schedule(delayMs: Long, action: () -> Unit): Cancellable
}

fun interface Cancellable {
    fun cancel()
}
