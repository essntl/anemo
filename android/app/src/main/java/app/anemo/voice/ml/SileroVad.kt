package app.anemo.voice.ml

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import app.anemo.voice.core.VoiceActivityDetector
import java.io.Closeable
import java.nio.FloatBuffer
import java.nio.LongBuffer

/**
 * Silero VAD (v5/v6 ONNX model, MIT): 512-sample chunks at 16 kHz with 64 samples of
 * context and a recurrent state. An 80 ms frame (1280 samples) is two or three chunks;
 * its probability is the highest of them.
 */
class SileroVad(private val env: OrtEnvironment, model: ByteArray) : VoiceActivityDetector, Closeable {
    private val session: OrtSession = env.createSession(model, singleThreaded())
    private var state = FloatArray(STATE_SIZE)
    private var context = FloatArray(CONTEXT)
    private val pending = FloatArray(CHUNK + 1_280 * 2)
    private var pendingSize = 0
    private var lastProbability = 0f

    override fun process(frame: ShortArray): Float {
        if (pendingSize + frame.size > pending.size) pendingSize = 0 // never with 80 ms frames
        for (s in frame) pending[pendingSize++] = s / 32768f
        var best = -1f
        var offset = 0
        while (pendingSize - offset >= CHUNK) {
            best = maxOf(best, runChunk(offset))
            offset += CHUNK
        }
        System.arraycopy(pending, offset, pending, 0, pendingSize - offset)
        pendingSize -= offset
        if (best >= 0f) lastProbability = best
        return lastProbability
    }

    private fun runChunk(offset: Int): Float {
        val input = FloatArray(CONTEXT + CHUNK)
        System.arraycopy(context, 0, input, 0, CONTEXT)
        System.arraycopy(pending, offset, input, CONTEXT, CHUNK)
        System.arraycopy(pending, offset + CHUNK - CONTEXT, context, 0, CONTEXT)
        OnnxTensor.createTensor(env, FloatBuffer.wrap(input), longArrayOf(1, input.size.toLong())).use { x ->
            OnnxTensor.createTensor(env, FloatBuffer.wrap(state), longArrayOf(2, 1, 128)).use { st ->
                OnnxTensor.createTensor(env, LongBuffer.wrap(longArrayOf(16_000)), longArrayOf()).use { sr ->
                    session.run(mapOf("input" to x, "state" to st, "sr" to sr)).use { out ->
                        val probability = (out[0] as OnnxTensor).floatBuffer.get(0)
                        val next = (out[1] as OnnxTensor).floatBuffer
                        state = FloatArray(STATE_SIZE).also { next.get(it) }
                        return probability
                    }
                }
            }
        }
    }

    override fun reset() {
        state = FloatArray(STATE_SIZE)
        context = FloatArray(CONTEXT)
        pendingSize = 0
        lastProbability = 0f
    }

    override fun close() = session.close()

    companion object {
        const val ASSET = "models/silero_vad.onnx"
        private const val CHUNK = 512
        private const val CONTEXT = 64
        private const val STATE_SIZE = 2 * 1 * 128
    }
}

internal fun singleThreaded() = OrtSession.SessionOptions().apply {
    setIntraOpNumThreads(1)
    setInterOpNumThreads(1)
}
