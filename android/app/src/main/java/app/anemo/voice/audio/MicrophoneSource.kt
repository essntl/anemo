package app.anemo.voice.audio

import android.annotation.SuppressLint
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import app.anemo.voice.core.AudioFormat16k

/**
 * The microphone: `AudioRecord` at 16 kHz mono 16-bit, read in 80 ms frames on its own
 * thread. Started only by [app.anemo.voice.service.ListenService] after its notification
 * shows, and stopped while paused. Frames go to [onFrame] and nowhere else.
 */
class MicrophoneSource {
    @Volatile private var running = false
    private var thread: Thread? = null
    private var record: AudioRecord? = null

    /** [device]: the Bluetooth headset's microphone when routed there, else null (the phone's). */
    @SuppressLint("MissingPermission") // checked before the service starts listening
    fun start(device: AudioDeviceInfo?, onFrame: (ShortArray) -> Unit) {
        if (running) return
        val min = AudioRecord.getMinBufferSize(
            AudioFormat16k.SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
        )
        val source = if (device != null) {
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
            throw IllegalStateException("The microphone could not be opened")
        }
        if (device != null) r.setPreferredDevice(device)
        record = r
        running = true
        r.startRecording()
        thread = Thread({ readLoop(r, onFrame) }, "anemo-mic").also { it.start() }
    }

    private fun readLoop(r: AudioRecord, onFrame: (ShortArray) -> Unit) {
        while (running) {
            val frame = ShortArray(AudioFormat16k.FRAME_SAMPLES)
            var filled = 0
            while (running && filled < frame.size) {
                val n = r.read(frame, filled, frame.size - filled)
                if (n < 0) {
                    running = false
                    return
                }
                filled += n
            }
            if (running) onFrame(frame)
        }
    }

    fun stop() {
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
    }
}
