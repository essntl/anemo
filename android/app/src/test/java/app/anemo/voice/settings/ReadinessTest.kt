package app.anemo.voice.settings

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class ReadinessTest {
    private val ok = VoiceSettings(address = "https://anemo.example.com", token = "anemo_secret")

    private fun check(
        s: VoiceSettings = ok,
        mic: Boolean = true,
        notifications: Boolean = true,
        models: Boolean = true,
    ) = Readiness.check(s, mic, notifications, models)

    @Test
    fun `ready when everything is there`() = assertNull(check())

    @Test
    fun `each missing piece is named`() {
        assertEquals(Problem.NoAddress, check(ok.copy(address = " ")))
        assertEquals(Problem.BadAddress, check(ok.copy(address = "http://anemo.lan")))
        assertEquals(Problem.NoToken, check(ok.copy(token = "")))
        assertEquals(Problem.NoMicrophone, check(mic = false))
        assertEquals(Problem.NoWakeWordModel, check(models = false))
    }

    @Test
    fun `never listens without its notification showing`() {
        assertEquals(Problem.NoNotifications, check(notifications = false))
    }

    @Test
    fun `the token is never in toString`() {
        assertFalse(ok.toString().contains("anemo_secret"))
    }

    @Test
    fun `wake word names`() {
        assertEquals("Hey Jarvis", ok.wakeWordName)
        assertEquals("Hey Anemo", ok.copy(wakeWord = WakeWord.Custom, customWordName = " Hey Anemo ").wakeWordName)
        assertEquals("your own word", ok.copy(wakeWord = WakeWord.Custom).wakeWordName)
        assertEquals(WakeWord.HeyJarvis, WakeWord.of("unknown"))
    }
}
