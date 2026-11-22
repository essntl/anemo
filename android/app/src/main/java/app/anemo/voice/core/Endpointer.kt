package app.anemo.voice.core

/**
 * Decides when a recording ends, from the VAD's speech probability of each frame.
 *
 * - Speech starts at a probability of [startThreshold] or more.
 * - After speech, [silenceMs] of frames under [stopThreshold] end it ([Result.End]).
 * - [maxSpeechMs] after speech started, or [maxMs] after the start, it ends whatever
 *   happens ([Result.End]).
 * - Without any speech within [noSpeechMs] it gives up ([Result.NoSpeech]): nothing is sent.
 */
class Endpointer(
    private val silenceMs: Int = 1_000,
    private val maxMs: Int = 60_000,
    private val maxSpeechMs: Int = maxMs,
    private val noSpeechMs: Int = 5_000,
    private val startThreshold: Float = 0.5f,
    private val stopThreshold: Float = 0.35f,
) {
    enum class Result { Continue, End, NoSpeech }

    private var elapsedMs = 0
    private var speechStartedAt = -1
    private var silentMs = 0

    val speechHeard: Boolean get() = speechStartedAt >= 0

    /** The longest a recording can last, in ms. */
    val maxTotalMs: Int get() = minOf(maxMs, noSpeechMs + maxSpeechMs)

    fun update(speechProbability: Float, frameMs: Int = AudioFormat16k.FRAME_MS): Result {
        if (!speechHeard && speechProbability >= startThreshold) speechStartedAt = elapsedMs
        elapsedMs += frameMs
        if (speechHeard) {
            when {
                speechProbability >= startThreshold -> silentMs = 0
                speechProbability < stopThreshold -> silentMs += frameMs
                else -> silentMs = 0
            }
        }
        return when {
            speechHeard && silentMs >= silenceMs -> Result.End
            speechHeard && elapsedMs - speechStartedAt >= maxSpeechMs -> Result.End
            elapsedMs >= maxMs -> if (speechHeard) Result.End else Result.NoSpeech
            !speechHeard && elapsedMs >= noSpeechMs -> Result.NoSpeech
            else -> Result.Continue
        }
    }
}
