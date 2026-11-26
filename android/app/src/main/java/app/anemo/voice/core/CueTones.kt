package app.anemo.voice.core

import kotlin.math.PI
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin

/** The phone's short sounds (docs/specs/07-voice-mode-android.md §1, "The sounds"). */
enum class Cue(
    /** False: plays even with "Start and stop sounds" off (the microphone opens without a wake word, or voice mode changes). */
    val optional: Boolean,
) {
    /** The wake word was detected: Anemo is recording. */
    Start(optional = true),

    /** The recording ended: the input was taken, Anemo is thinking. */
    End(optional = true),

    /** The wake word was heard, but no speech came after it. */
    Timeout(optional = true),

    /** The phone listens for the answer to a question, an approval or a plan. */
    Reply(optional = false),

    /** Voice mode: the microphone opens again after an answer. */
    Reopen(optional = false),
    VoiceModeOn(optional = false),
    VoiceModeOff(optional = false),
}

/**
 * The cue sounds as PCM made in code (no sound files) and their vibration patterns. Pure,
 * so the lengths and the differences between the sounds are unit-tested; `audio/ToneCues`
 * plays them.
 */
object CueTones {
    const val SAMPLE_RATE = 24_000
    private const val AMPLITUDE = 0.45
    private const val FADE_MS = 6

    /** A note; [hz] 0 is a pause. */
    data class Note(val hz: Double, val ms: Int)

    fun notes(cue: Cue): List<Note> = when (cue) {
        Cue.Start, Cue.Reopen -> listOf(Note(E5, 60), Note(0.0, 20), Note(A5, 60))
        Cue.End -> listOf(Note(A5, 60), Note(0.0, 20), Note(E5, 60))
        Cue.Timeout -> listOf(Note(A4, 100), Note(0.0, 60), Note(A4, 100))
        Cue.Reply -> listOf(Note(A5, 60), Note(0.0, 20), Note(D6, 60))
        Cue.VoiceModeOn -> listOf(Note(C5, 90), Note(0.0, 15), Note(E5, 90), Note(0.0, 15), Note(G5, 90))
        Cue.VoiceModeOff -> listOf(Note(G5, 90), Note(0.0, 15), Note(E5, 90), Note(0.0, 15), Note(C5, 90))
    }

    fun durationMs(cue: Cue): Int = notes(cue).sumOf { it.ms }

    /** 16-bit mono PCM at [SAMPLE_RATE]; each note fades in and out, so nothing clicks. */
    fun pcm(cue: Cue): ShortArray {
        val out = ShortArray(SAMPLE_RATE * durationMs(cue) / 1000)
        var at = 0
        for (note in notes(cue)) {
            val n = SAMPLE_RATE * note.ms / 1000
            val fade = min(SAMPLE_RATE * FADE_MS / 1000, n / 2)
            if (note.hz > 0) {
                for (i in 0 until n) {
                    val envelope = min(1.0, min(i, n - 1 - i).toDouble() / fade)
                    val value = sin(2 * PI * note.hz * i / SAMPLE_RATE) * AMPLITUDE * envelope
                    out[at + i] = (value * Short.MAX_VALUE).roundToInt().toShort()
                }
            }
            at += n
        }
        return out
    }

    /**
     * The buzz, as Android's waveform timings: pause, buzz, pause, buzz… in ms, starting
     * with a pause.
     */
    fun vibration(cue: Cue): LongArray = when (cue) {
        Cue.Start, Cue.End, Cue.Reply, Cue.Reopen -> longArrayOf(0, 40)
        Cue.Timeout -> longArrayOf(0, 40, 80, 40)
        Cue.VoiceModeOn -> longArrayOf(0, 120, 80, 40)
        Cue.VoiceModeOff -> longArrayOf(0, 120, 80, 120)
    }

    private const val A4 = 440.0
    private const val C5 = 523.25
    private const val E5 = 659.25
    private const val G5 = 783.99
    private const val A5 = 880.0
    private const val D6 = 1174.66
}
