package app.anemo.voice

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** What the manifest must declare for the app to work on a phone (not seen by JVM tests). */
class ManifestTest {
    private val manifest = File("src/main/AndroidManifest.xml").readText()

    @Test
    fun `the speech engine is declared, so answers can be spoken on Android 11 and later`() {
        val queries = Regex("<queries>(.*?)</queries>", RegexOption.DOT_MATCHES_ALL).find(manifest)?.value.orEmpty()
        assertTrue(queries.contains("android.intent.action.TTS_SERVICE"))
    }
}
