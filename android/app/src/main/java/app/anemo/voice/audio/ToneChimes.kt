package app.anemo.voice.audio

import android.media.AudioManager
import android.media.ToneGenerator
import app.anemo.voice.core.Chimes

/**
 * The start and stop sounds, from Android's tone generator (no sound files). [enabled]
 * switches off the request sounds; the reply sound always plays.
 */
class ToneChimes(private val enabled: Boolean) : Chimes {
    private val tones: ToneGenerator? = try {
        ToneGenerator(AudioManager.STREAM_MUSIC, VOLUME)
    } catch (e: RuntimeException) {
        null // no tone generator on this device
    }

    override fun start() {
        if (enabled) tones?.startTone(ToneGenerator.TONE_PROP_BEEP, 120)
    }

    override fun stop() {
        if (enabled) tones?.startTone(ToneGenerator.TONE_PROP_ACK, 160)
    }

    override fun reply() {
        tones?.startTone(ToneGenerator.TONE_PROP_BEEP2, 200)
    }

    fun release() {
        tones?.release()
    }

    private companion object {
        const val VOLUME = 70
    }
}
