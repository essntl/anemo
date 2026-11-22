package app.anemo.voice.ml

import app.anemo.voice.settings.WakeWord
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.IOException

class ModelFilesTest {
    @get:Rule val tmp = TemporaryFolder()
    private val server = MockWebServer()
    private val paths = mutableListOf<String>()

    init {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl!!.encodedPath
                synchronized(paths) { paths += path }
                return if (path.endsWith(".onnx")) {
                    MockResponse().setBody(Buffer().write(body))
                } else {
                    MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
    }

    @After
    fun tearDown() = server.shutdown()

    /** What the fake release serves for every .onnx file, and its sha256. */
    private val body = ByteArray(4_096) { 1 }
    private val sha = java.security.MessageDigest.getInstance("SHA-256").digest(body).joinToString("") { "%02x".format(it) }
    private val pins = ModelFiles.SHA256.mapValues { sha }

    private fun files(
        pins: Map<String, String> = this.pins,
        check: (java.io.File) -> Unit = {},
    ) = ModelFiles(tmp.root, OkHttpClient(), server.url("/release/"), pins, check)

    @Test
    fun `downloads the shared models and the word once`() {
        val f = files()
        assertFalse(f.present(WakeWord.HeyJarvis))
        f.download(WakeWord.HeyJarvis)
        assertTrue(f.present(WakeWord.HeyJarvis))
        assertEquals(
            listOf("/release/melspectrogram.onnx", "/release/embedding_model.onnx", "/release/hey_jarvis_v0.1.onnx"),
            paths,
        )
        f.download(WakeWord.HeyJarvis)
        assertEquals(3, paths.size)
        f.download(WakeWord.Alexa)
        assertEquals("/release/alexa_v0.1.onnx", paths.last())
    }

    @Test
    fun `a custom word is imported, never downloaded`() {
        val f = files()
        f.download(WakeWord.Custom)
        assertFalse(f.present(WakeWord.Custom))
        assertEquals(2, paths.size)
        f.importCustom(ByteArray(2_048) { 2 }.inputStream())
        assertTrue(f.present(WakeWord.Custom))
    }

    @Test(expected = IOException::class)
    fun `a tiny file is not a model`() {
        files().importCustom(ByteArray(10).inputStream())
    }

    @Test
    fun `a download with the wrong checksum is refused and not kept`() {
        val f = files(pins = pins + (ModelFiles.EMBEDDING to "0".repeat(64)))
        val e = runCatching { f.download(WakeWord.HeyJarvis) }.exceptionOrNull()
        assertTrue(e is IOException && e.message!!.contains("checksum"))
        assertFalse(f.embedding.exists())
        assertTrue(tmp.root.listFiles()!!.none { it.name.endsWith(".part") })
    }

    @Test
    fun `the release files are pinned`() {
        assertEquals(5, ModelFiles.SHA256.size)
        assertTrue(ModelFiles.SHA256.values.all { it.matches(Regex("[0-9a-f]{64}")) })
        WakeWord.entries.filter { it != WakeWord.Custom }.forEach { assertTrue(it.file in ModelFiles.SHA256) }
    }

    @Test
    fun `an imported word that fails the check is not kept`() {
        val f = files(check = { throw IOException("This model's input is [1, 576]") })
        val e = runCatching { f.importCustom(ByteArray(2_048).inputStream()) }.exceptionOrNull()
        assertEquals("This model's input is [1, 576]", e?.message)
        assertFalse(f.word(WakeWord.Custom).exists())
    }
}
