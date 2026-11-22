package app.anemo.voice.ml

import ai.onnxruntime.OrtEnvironment
import app.anemo.voice.core.AudioFormat16k
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * The real models on the JVM (desktop ONNX Runtime, same Java API as on Android).
 *
 * Silero VAD is bundled, so its tests always run. The openWakeWord models are not in the
 * repository (see android/README.md); the wake word tests run when the system property
 * `anemo.models` names a folder with melspectrogram.onnx, embedding_model.onnx,
 * hey_jarvis_v0.1.onnx and two 16 kHz recordings, hey_jarvis.wav and other.wav
 * (`OWW_MODELS=<folder> ./gradlew test`), and are skipped otherwise.
 */
class OnnxModelsTest {
    private val env = OrtEnvironment.getEnvironment()
    private val modelsDir = System.getProperty("anemo.models").orEmpty().takeIf { it.isNotBlank() }?.let(::File)

    private fun silero() = SileroVad(env, File("src/main/assets/${SileroVad.ASSET}").readBytes())

    private fun frames(samples: ShortArray): List<ShortArray> =
        samples.toList().chunked(AudioFormat16k.FRAME_SAMPLES)
            .filter { it.size == AudioFormat16k.FRAME_SAMPLES }
            .map { it.toShortArray() }

    @Test
    fun `silero hears no speech in silence or faint noise`() {
        silero().use { vad ->
            val silence = frames(ShortArray(16_000 * 2))
            val maxSilence = silence.maxOf { vad.process(it) }
            assertTrue("silence: $maxSilence", maxSilence < 0.2f)
            val rnd = java.util.Random(1)
            val noise = frames(ShortArray(16_000 * 2) { (rnd.nextGaussian() * 30).toInt().toShort() })
            val maxNoise = noise.maxOf { vad.process(it) }
            assertTrue("noise: $maxNoise", maxNoise < 0.5f)
        }
    }

    @Test
    fun `silero keeps working across resets and odd frame sizes`() {
        silero().use { vad ->
            repeat(3) {
                vad.reset()
                frames(ShortArray(16_000)).forEach { vad.process(it) }
            }
            vad.process(ShortArray(700))
            vad.process(ShortArray(100))
        }
    }

    @Test
    fun `silero hears synthesized speech`() {
        val dir = modelsDir
        assumeTrue("set anemo.models to run", dir != null && File(dir, "other.wav").exists())
        silero().use { vad ->
            val max = frames(readWav(File(dir, "other.wav"))).maxOf { vad.process(it) }
            assertTrue("speech: $max", max > 0.8f)
        }
    }

    @Test
    fun `openWakeWord hears hey jarvis and nothing in other speech`() {
        val dir = modelsDir
        assumeTrue("set anemo.models to run", dir != null && File(dir, "hey_jarvis_v0.1.onnx").exists())
        OpenWakeWord(
            env,
            File(dir, "melspectrogram.onnx").readBytes(),
            File(dir, "embedding_model.onnx").readBytes(),
            File(dir, "hey_jarvis_v0.1.onnx").readBytes(),
            threshold = 0.5f,
        ).use { oww ->
            val pad = ShortArray(16_000)
            val heyJarvis = maxScore(oww, pad + readWav(File(dir!!, "hey_jarvis.wav")) + pad)
            assertTrue("hey jarvis: $heyJarvis", heyJarvis >= 0.5f)
            oww.reset()
            val other = maxScore(oww, pad + readWav(File(dir, "other.wav")) + pad)
            assertTrue("other speech: $other", other < 0.5f)
            oww.reset()
            val silence = maxScore(oww, ShortArray(16_000 * 3))
            assertTrue("silence: $silence", silence < 0.1f)
        }
    }

    private fun maxScore(oww: OpenWakeWord, samples: ShortArray): Float =
        frames(samples).maxOf { oww.process(it); oww.lastScore }

    /** The samples of a 16 kHz mono 16-bit WAV file. */
    private fun readWav(file: File): ShortArray {
        val b = ByteBuffer.wrap(file.readBytes()).order(ByteOrder.LITTLE_ENDIAN)
        var pos = 12
        while (pos + 8 <= b.limit()) {
            val id = String(b.array(), pos, 4)
            val size = b.getInt(pos + 4)
            if (id == "data") {
                val n = minOf(size, b.limit() - pos - 8) / 2
                return ShortArray(n) { b.getShort(pos + 8 + it * 2) }
            }
            pos += 8 + size + (size and 1)
        }
        error("no data chunk in $file")
    }
}
