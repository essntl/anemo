package app.anemo.voice.ml

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import ai.onnxruntime.TensorInfo
import app.anemo.voice.core.AudioFormat16k
import app.anemo.voice.core.WakeWordDetector
import java.io.Closeable
import java.nio.FloatBuffer
import kotlin.random.Random

/**
 * openWakeWord's streaming pipeline (github.com/dscripka/openWakeWord, `model.py` and
 * `utils.py`), for 80 ms frames:
 *
 * 1. melspectrogram.onnx on the frame plus 480 samples before it → 8 mel frames of 32,
 *    scaled as `x / 10 + 2`;
 * 2. embedding_model.onnx on the last 76 mel frames → one 96-value embedding;
 * 3. the word's model on the last N embeddings (N from its input shape, 16 for the
 *    pre-trained words) → a score from 0 to 1. At [threshold] or more, the word was said.
 *
 * The first five scores after a reset are ignored, as openWakeWord does.
 */
class OpenWakeWord(
    private val env: OrtEnvironment,
    melModel: ByteArray,
    embeddingModel: ByteArray,
    wordModel: ByteArray,
    private val threshold: Float,
) : WakeWordDetector, Closeable {
    private val mel = env.createSession(melModel, singleThreaded())
    private val embedding = env.createSession(embeddingModel, singleThreaded())
    private val word = env.createSession(wordModel, singleThreaded())
    private val wordFrames: Int = inputShape(word)[1].toInt().takeIf { it > 0 } ?: 16

    private val raw = FloatArray(AudioFormat16k.FRAME_SAMPLES + MEL_EXTRA)
    private var rawSize = 0
    private val melFrames = ArrayDeque<FloatArray>()
    private val features = ArrayDeque<FloatArray>()
    private val startFeatures: List<FloatArray>
    private var framesSinceReset = 0

    /** The last score, for the settings screen's level meter and for tests. */
    override var lastScore = 0f
        private set

    init {
        // As openWakeWord does: start the embedding buffer from 4 s of quiet noise.
        val rnd = Random(42)
        val noise = FloatArray(AudioFormat16k.SAMPLE_RATE * 4) { (rnd.nextInt(-1_000, 1_000)).toFloat() }
        startFeatures = batchEmbeddings(melspectrogram(noise))
        reset()
    }

    override fun process(frame: ShortArray): Boolean {
        // keep the last 480 samples before this frame, then the frame
        val keep = minOf(rawSize, MEL_EXTRA)
        System.arraycopy(raw, rawSize - keep, raw, 0, keep)
        for (i in frame.indices) raw[keep + i] = frame[i].toFloat()
        rawSize = keep + frame.size

        melspectrogram(raw.copyOf(rawSize)).forEach { push(melFrames, it, MAX_MEL) }
        push(features, embed(melFrames.takeLast(EMBED_WINDOW)), MAX_FEATURES)

        framesSinceReset++
        lastScore = if (framesSinceReset <= IGNORED_FIRST) 0f else score()
        return lastScore >= threshold
    }

    override fun reset() {
        rawSize = 0
        melFrames.clear()
        repeat(EMBED_WINDOW) { melFrames.addLast(FloatArray(MEL_BINS) { 1f }) }
        features.clear()
        startFeatures.forEach { features.addLast(it) }
        framesSinceReset = 0
        lastScore = 0f
    }

    /** Mel frames of [samples] (int16 scale), already scaled as openWakeWord does. */
    private fun melspectrogram(samples: FloatArray): List<FloatArray> {
        OnnxTensor.createTensor(env, FloatBuffer.wrap(samples), longArrayOf(1, samples.size.toLong())).use { x ->
            mel.run(mapOf(mel.inputNames.first() to x)).use { out ->
                val t = out[0] as OnnxTensor
                val shape = t.info.shape
                val bins = shape.last().toInt()
                val buf = t.floatBuffer
                val n = buf.remaining() / bins
                return List(n) { FloatArray(bins) { buf.get() / 10f + 2f } }
            }
        }
    }

    private fun embed(window: List<FloatArray>): FloatArray = runEmbedding(listOf(window)).first()

    private fun batchEmbeddings(frames: List<FloatArray>): List<FloatArray> {
        val windows = (0..frames.size - EMBED_WINDOW step 8).map { frames.subList(it, it + EMBED_WINDOW) }
        return runEmbedding(windows)
    }

    private fun runEmbedding(windows: List<List<FloatArray>>): List<FloatArray> {
        val data = FloatArray(windows.size * EMBED_WINDOW * MEL_BINS)
        var i = 0
        for (w in windows) for (f in w) for (v in f) data[i++] = v
        val shape = longArrayOf(windows.size.toLong(), EMBED_WINDOW.toLong(), MEL_BINS.toLong(), 1)
        OnnxTensor.createTensor(env, FloatBuffer.wrap(data), shape).use { x ->
            embedding.run(mapOf(embedding.inputNames.first() to x)).use { out ->
                val buf = (out[0] as OnnxTensor).floatBuffer
                return List(windows.size) { FloatArray(EMBEDDING) { buf.get() } }
            }
        }
    }

    private fun score(): Float {
        val last = features.takeLast(wordFrames)
        val data = FloatArray(wordFrames * EMBEDDING)
        last.forEachIndexed { i, f -> System.arraycopy(f, 0, data, i * EMBEDDING, EMBEDDING) }
        val shape = longArrayOf(1, wordFrames.toLong(), EMBEDDING.toLong())
        OnnxTensor.createTensor(env, FloatBuffer.wrap(data), shape).use { x ->
            word.run(mapOf(word.inputNames.first() to x)).use { out ->
                return (out[0] as OnnxTensor).floatBuffer.get(0)
            }
        }
    }

    override fun close() {
        word.close()
        embedding.close()
        mel.close()
    }

    companion object {
        private const val MEL_EXTRA = 160 * 3
        private const val MEL_BINS = 32
        private const val EMBED_WINDOW = 76
        private const val EMBEDDING = 96
        private const val MAX_MEL = 970
        private const val MAX_FEATURES = 120
        private const val IGNORED_FIRST = 5

        private fun <T> push(q: ArrayDeque<T>, item: T, max: Int) {
            q.addLast(item)
            while (q.size > max) q.removeFirst()
        }

        private fun inputShape(s: OrtSession): LongArray =
            (s.inputInfo.values.first().info as TensorInfo).shape

        /**
         * Checks that [model] is an openWakeWord word model: one input of N embeddings of 96
         * values, a single score out, and it runs. Throws [IllegalArgumentException] saying
         * what is wrong, so an imported file never becomes a wake word that never fires.
         */
        fun checkWordModel(env: OrtEnvironment, model: ByteArray) {
            val session = try {
                env.createSession(model, singleThreaded())
            } catch (e: Exception) {
                throw IllegalArgumentException("This file is not an ONNX model.")
            }
            session.use { s ->
                require(s.inputInfo.size == 1) { "This model takes ${s.inputInfo.size} inputs; a wake word model takes one." }
                val input = (s.inputInfo.values.first().info as? TensorInfo)?.shape
                require(input != null && input.size == 3 && input[2] == EMBEDDING.toLong() && input[1] != 0L) {
                    "This model's input is ${input?.contentToString()}; a wake word model takes [1, N, 96]."
                }
                val output = (s.outputInfo.values.first().info as? TensorInfo)?.shape
                require(output != null && output.isNotEmpty() && output.last() == 1L) {
                    "This model's output is ${output?.contentToString()}; a wake word model gives one score."
                }
                val frames = input[1].takeIf { it > 0 } ?: 16
                val zeros = FloatArray((frames * EMBEDDING).toInt())
                OnnxTensor.createTensor(env, FloatBuffer.wrap(zeros), longArrayOf(1, frames, EMBEDDING.toLong())).use { x ->
                    try {
                        s.run(mapOf(s.inputNames.first() to x)).close()
                    } catch (e: Exception) {
                        throw IllegalArgumentException("This model doesn't run: ${e.message}")
                    }
                }
            }
        }
    }
}
