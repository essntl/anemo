package app.anemo.voice.audio

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import app.anemo.voice.core.AudioFormat16k
import app.anemo.voice.core.Microphone

/**
 * The microphone: `AudioRecord` at 16 kHz mono 16-bit, read in 80 ms frames on its own
 * thread. Opened only by the listening session after the service's notification shows,
 * and closed while paused. With [routing], a connected Bluetooth headset's microphone is
 * used. Frames go to `onFrame` and nowhere else; a read error goes to `onError`.
 * Android's echo canceller is switched on when the phone has one, so in voice mode the
 * end of a spoken answer isn't heard as the next request.
 */
class MicrophoneSource(private val routing: BluetoothRouting?) : Microphone {
    @Volatile private var running = false
    private var thread: Thread? = null
    private var record: AudioRecord? = null
    private var echo: AcousticEchoCanceler? = null

    @SuppressLint("MissingPermission") // checked before the service starts listening
    override fun open(onFrame: (ShortArray) -> Unit, onError: (String) -> Unit) {
        if (running) return
        val headset = routing?.route()
        val min = AudioRecord.getMinBufferSize(
            AudioFormat16k.SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
        )
        val source = if (headset != null) {
            MediaRecorder.AudioSource.VOICE_COMMUNICATION
        } else {
            MediaRecorder.AudioSource.VOICE_RECOGNITION
        }
        val r = AudioRecord(
            source,
            AudioFormat16k.SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            maxOf(min, AudioFormat16k.FRAME_SAMPLES * 2 * 4),
        )
        if (r.state != AudioRecord.STATE_INITIALIZED) {
            r.release()
            routing?.release()
            throw IllegalStateException("the microphone is not available")
        }
        if (headset != null) r.setPreferredDevice(headset)
        echo = echoCanceller(r)
        record = r
        running = true
        r.startRecording()
        thread = Thread({ readLoop(r, onFrame, onError) }, "anemo-mic").also { it.start() }
    }

    private fun readLoop(r: AudioRecord, onFrame: (ShortArray) -> Unit, onError: (String) -> Unit) {
        while (running) {
            val frame = ShortArray(AudioFormat16k.FRAME_SAMPLES)
            var filled = 0
            while (running && filled < frame.size) {
                val n = r.read(frame, filled, frame.size - filled)
                if (n < 0) {
                    if (running) onError("read error $n")
                    return
                }
                filled += n
            }
            if (running) onFrame(frame)
        }
    }

    private fun echoCanceller(r: AudioRecord): AcousticEchoCanceler? = try {
        if (AcousticEchoCanceler.isAvailable()) AcousticEchoCanceler.create(r.audioSessionId)?.apply { enabled = true } else null
    } catch (e: RuntimeException) {
        null // without it: the first frames after a voice-mode reopen are skipped anyway
    }

    override fun close() {
        running = false
        thread?.join(500)
        thread = null
        record?.let {
            try {
                it.stop()
            } catch (e: IllegalStateException) {
                // never started
            }
            it.release()
        }
        record = null
        echo?.release()
        echo = null
        routing?.release()
    }
}
