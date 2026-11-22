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
                    MockResponse().setBody(Buffer().write(ByteArray(4_096) { 1 }))
                } else {
                    MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
    }

    @After
    fun tearDown() = server.shutdown()

    private fun files() = ModelFiles(tmp.root, OkHttpClient(), server.url("/release/"))

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
}
