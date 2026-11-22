package app.anemo.voice.core

/**
 * Decides when a recording ends, from the VAD's speech probability of each frame.
 *
 * - Speech starts at a probability of [startThreshold] or more.
 * - After speech, [silenceMs] of frames under [stopThreshold] end it ([Result.End]).
 * - At [maxMs] it ends whatever happens ([Result.End]).
 * - Without any speech within [noSpeechMs] it gives up ([Result.NoSpeech]): nothing is sent.
 */
class Endpointer(
    private val silenceMs: Int = 1_000,
    private val maxMs: Int = 60_000,
    private val noSpeechMs: Int = 5_000,
    private val startThreshold: Float = 0.5f,
    private val stopThreshold: Float = 0.35f,
) {
    enum class Result { Continue, End, NoSpeech }

    private var elapsedMs = 0
    private var heardSpeech = false
    private var silentMs = 0

    val speechHeard: Boolean get() = heardSpeech

    fun update(speechProbability: Float, frameMs: Int = AudioFormat16k.FRAME_MS): Result {
        elapsedMs += frameMs
        if (speechProbability >= startThreshold) {
            heardSpeech = true
            silentMs = 0
        } else if (heardSpeech && speechProbability < stopThreshold) {
            silentMs += frameMs
        } else if (heardSpeech) {
            silentMs = 0
        }
        return when {
            heardSpeech && silentMs >= silenceMs -> Result.End
            elapsedMs >= maxMs -> if (heardSpeech) Result.End else Result.NoSpeech
            !heardSpeech && elapsedMs >= noSpeechMs -> Result.NoSpeech
            else -> Result.Continue
        }
    }
}
