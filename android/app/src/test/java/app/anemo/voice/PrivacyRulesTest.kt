package app.anemo.voice

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The hard rules that are about what the code doesn't do, checked on the sources:
 * nothing logs (so the token and transcripts can't reach a log), and only the model files
 * and the settings/history stores write to storage (so no audio or transcript is kept).
 */
class PrivacyRulesTest {
    private val sources = File("src/main/java").walkTopDown().filter { it.extension == "kt" }.toList()

    private fun offenders(pattern: Regex, allowed: Set<String> = emptySet()) =
        sources.filter { it.name !in allowed && pattern.containsMatchIn(it.readText()) }.map { it.name }

    @Test
    fun `nothing logs, except Logcat`() {
        val found = offenders(
            Regex("""\bLog\.[a-z]+\(|println\(|printStackTrace\(|HttpLoggingInterceptor"""),
            allowed = setOf("Logcat.kt"),
        )
        assertTrue("logging in $found", found.isEmpty())
    }

    @Test
    fun `Logcat takes no text, so no token, transcript or answer can be logged`() {
        val logcat = sources.single { it.name == "Logcat.kt" }.readText()
        val parameters = Regex("""fun \w+\(([^)]*)\)""").findAll(logcat).flatMap { it.groupValues[1].split(",") }
            .map { it.trim() }.filter { it.isNotEmpty() }.toList()
        assertTrue(parameters.isNotEmpty())
        assertTrue("text parameters in $parameters", parameters.none { it.endsWith(": String") || it.endsWith(": CharSequence") })
    }

    @Test
    fun `only model files are written as files`() {
        val found = offenders(
            Regex("""FileOutputStream|outputStream\(\)|writeBytes\(|writeText\(|openFileOutput"""),
            allowed = setOf("ModelFiles.kt"),
        )
        assertTrue("file writes in $found", found.isEmpty())
    }

    @Test
    fun `the token never goes into a URL`() {
        val found = offenders(Regex("""addQueryParameter|\?token="""))
        assertTrue("query parameters in $found", found.isEmpty())
    }

    @Test
    fun `the sources were found`() = assertTrue(sources.size > 20)
}
