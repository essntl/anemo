package app.anemo.voice.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Build
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import app.anemo.voice.core.Chimes
import app.anemo.voice.core.Cue
import app.anemo.voice.core.CueTones

/**
 * Plays the cues of [CueTones] and buzzes with them.
 *
 * - The sounds play from static `AudioTrack`s made once (so a cue starts within a few
 *   tens of ms) with the usage `USAGE_ASSISTANCE_SONIFICATION`, Android's usage for user
 *   interface sounds. It follows the "system sounds" volume (on phones: the ring volume),
 *   not the media volume, so music at 0 doesn't silence the cue; and it plays where the
 *   user listens (a headset when one is connected). Why not alarm, notification or call
 *   audio: docs/specs/07-voice-mode-android.md §1, "Which stream the cues play on".
 * - [sounds] off ("Start and stop sounds") silences only the optional cues ([Cue.optional]).
 * - [vibrate] buzzes with every cue that plays: in silent mode the buzz is the cue.
 */
class ToneCues(context: Context, private val sounds: Boolean, private val vibrate: Boolean) : Chimes {
    private val attributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build()
    private val tracks: Map<Cue, AudioTrack> =
        Cue.entries.mapNotNull { cue -> track(cue)?.let { cue to it } }.toMap()
    private val vibrator: Vibrator? = vibrator(context)?.takeIf { it.hasVibrator() }

    override fun play(cue: Cue) {
        if (cue.optional && !sounds) return
        tracks[cue]?.let(::restart)
        if (vibrate) buzz(cue)
    }

    fun release() {
        tracks.values.forEach { runCatching { it.release() } }
    }

    private fun track(cue: Cue): AudioTrack? = try {
        val pcm = CueTones.pcm(cue)
        val format = AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(CueTones.SAMPLE_RATE)
            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .build()
        AudioTrack.Builder()
            .setAudioAttributes(attributes)
            .setAudioFormat(format)
            .setTransferMode(AudioTrack.MODE_STATIC)
            .setBufferSizeInBytes(pcm.size * 2)
            .setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY)
            .build()
            .also { it.write(pcm, 0, pcm.size) }
    } catch (e: RuntimeException) {
        null // no audio output: the buzz still comes
    }

    /** A static track plays again from the start after stop and reload. */
    private fun restart(track: AudioTrack) {
        try {
            if (track.playState != AudioTrack.PLAYSTATE_STOPPED) track.stop()
            track.reloadStaticData()
            track.play()
        } catch (e: IllegalStateException) {
            // released meanwhile (the service stopped)
        }
    }

    private fun buzz(cue: Cue) {
        val v = vibrator ?: return
        val effect = VibrationEffect.createWaveform(CueTones.vibration(cue), -1)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                // Accessibility vibrations are kept when "touch feedback" is off.
                v.vibrate(effect, VibrationAttributes.createForUsage(VibrationAttributes.USAGE_ACCESSIBILITY))
            } else {
                @Suppress("DEPRECATION")
                v.vibrate(effect, attributes)
            }
        } catch (e: RuntimeException) {
            // no vibrator after all, or not allowed
        }
    }

    private fun vibrator(context: Context): Vibrator? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            context.getSystemService(VibratorManager::class.java)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Vibrator::class.java)
        }
}
