package app.anemo.voice.audio

import android.media.AudioManager
import android.media.ToneGenerator
import app.anemo.voice.core.Chimes

/** The start and stop sounds, from Android's tone generator (no sound files). */
class ToneChimes(private val enabled: Boolean) : Chimes {
    private val tones: ToneGenerator? = if (enabled) {
        try {
            ToneGenerator(AudioManager.STREAM_MUSIC, VOLUME)
        } catch (e: RuntimeException) {
            null // no tone generator on this device: silently without sounds
        }
    } else {
        null
    }

    override fun start() {
        tones?.startTone(ToneGenerator.TONE_PROP_BEEP, 120)
    }

    override fun stop() {
        tones?.startTone(ToneGenerator.TONE_PROP_ACK, 160)
    }

    fun release() {
        tones?.release()
    }

    private companion object {
        const val VOLUME = 70
    }
}
