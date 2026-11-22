package app.anemo.voice.core

import java.nio.ByteBuffer
import java.nio.ByteOrder

/** Audio format of everything the app records: 16 kHz, mono, 16-bit, 80 ms frames. */
object AudioFormat16k {
    const val SAMPLE_RATE = 16_000
    const val FRAME_SAMPLES = 1_280
    const val FRAME_MS = 80
}

/** Encodes 16-bit PCM as a WAV file in memory (the recording is never written to disk). */
object Wav {
    private const val HEADER_BYTES = 44

    fun encode(samples: ShortArray, sampleRate: Int = AudioFormat16k.SAMPLE_RATE): ByteArray {
        val dataBytes = samples.size * 2
        val buf = ByteBuffer.allocate(HEADER_BYTES + dataBytes).order(ByteOrder.LITTLE_ENDIAN)
        buf.put("RIFF".toByteArray(Charsets.US_ASCII))
        buf.putInt(36 + dataBytes)
        buf.put("WAVE".toByteArray(Charsets.US_ASCII))
        buf.put("fmt ".toByteArray(Charsets.US_ASCII))
        buf.putInt(16) // PCM header size
        buf.putShort(1) // PCM
        buf.putShort(1) // mono
        buf.putInt(sampleRate)
        buf.putInt(sampleRate * 2) // byte rate
        buf.putShort(2) // block align
        buf.putShort(16) // bits per sample
        buf.put("data".toByteArray(Charsets.US_ASCII))
        buf.putInt(dataBytes)
        for (s in samples) buf.putShort(s)
        return buf.array()
    }
}

/** Collects frames of one recording in memory. */
class RecordingBuffer(private val maxSamples: Int) {
    private var data = ShortArray(AudioFormat16k.FRAME_SAMPLES * 16)
    var size = 0
        private set

    fun add(frame: ShortArray) {
        val n = minOf(frame.size, maxSamples - size)
        if (n <= 0) return
        if (size + n > data.size) data = data.copyOf(maxOf(data.size * 2, size + n))
        System.arraycopy(frame, 0, data, size, n)
        size += n
    }

    fun samples(): ShortArray = data.copyOf(size)

    fun clear() {
        data = ShortArray(0)
        size = 0
    }
}
