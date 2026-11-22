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
}

/** Voice activity: speech probability (0..1) of an 80 ms frame. */
interface VoiceActivityDetector {
    fun process(frame: ShortArray): Float
    fun reset()
}

/** The short sounds that say "I'm listening" and "I stopped". */
interface Chimes {
    fun start()
    fun stop()
}

/** Text to speech. [onDone] gets true when the text was spoken to the end. */
interface Speaker {
    fun speak(text: String, onDone: (completed: Boolean) -> Unit)
    fun stop()
}

/** Anemo's voice REST (device-contracts.md §4). */
interface VoiceBackend {
    /**
     * A request ([status] false) or the status command ([status] true). [conversationId]
     * continues a chat within the follow-up window.
     */
    fun sendTurn(wav: ByteArray, conversationId: String?, status: Boolean, onResult: (TurnResult) -> Unit)

    fun sendReply(wav: ByteArray, approvalId: String, onResult: (ReplyResult) -> Unit)
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
