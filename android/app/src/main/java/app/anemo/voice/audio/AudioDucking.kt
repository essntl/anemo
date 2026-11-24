package app.anemo.voice.audio

import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import app.anemo.voice.core.AudioFocus

/**
 * While the phone records, other apps' sound gets quiet: transient audio focus that lets
 * them duck (`AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK`), asked for the moment the wake word is
 * detected and given back when the recording ends. The spoken answer takes its own focus
 * (`AndroidSpeaker`).
 */
class AudioDucking(private val audio: AudioManager) : AudioFocus {
    private val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
        .setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ASSISTANT)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build(),
        )
        .build()
    private var held = false

    override fun duck() {
        if (held) return
        held = try {
            audio.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        } catch (e: RuntimeException) {
            false // the recording goes on without ducking
        }
    }

    override fun release() {
        if (!held) return
        held = false
        runCatching { audio.abandonAudioFocusRequest(request) }
    }
}
