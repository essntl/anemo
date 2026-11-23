package app.anemo.voice.ui

import app.anemo.voice.settings.Sensitivity
import app.anemo.voice.settings.VoiceSettings
import app.anemo.voice.settings.WakeWord
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SettingsFormTest {
    private val saved = VoiceSettings(
        address = "https://anemo.example.com",
        token = "anemo_secret",
        ttsVoice = "en-gb-x-rjs-local",
        ttsSpeed = 1.25f,
    )

    private fun valid(form: SettingsForm): VoiceSettings = (form.toSettings(saved) as SaveResult.Valid).settings

    @Test
    fun `the form starts from the saved settings, with the token field empty`() {
        val f = SettingsForm.from(saved)
        assertEquals("https://anemo.example.com", f.address)
        assertEquals("", f.token)
        assertEquals(7, f.speedStep)
        assertEquals("", f.voice) // until the voices are loaded
    }

    @Test
    fun `an empty token field keeps the saved token`() {
        assertEquals("anemo_secret", valid(SettingsForm.from(saved)).token)
        assertEquals("anemo_new", valid(SettingsForm.from(saved).copy(token = "  anemo_new ")).token)
    }

    @Test
    fun `an address that isn't https is refused`() {
        val r = SettingsForm.from(saved).copy(address = "http://anemo.example.com").toSettings(saved)
        assertEquals(SaveResult.Invalid(SettingsForm.BAD_ADDRESS), r)
    }

    @Test
    fun `an empty address or one without a scheme can be saved`() {
        assertEquals("", valid(SettingsForm.from(saved).copy(address = "  ")).address)
        assertEquals("anemo.example.com", valid(SettingsForm.from(saved).copy(address = " anemo.example.com ")).address)
    }

    @Test
    fun `everything else is taken from the form`() {
        val s = valid(
            SettingsForm.from(saved).copy(
                wakeWord = WakeWord.Custom,
                customWordName = "Hey Anemo",
                sensitivity = Sensitivity.High,
                sounds = false,
                bluetoothMic = false,
                voice = "",
                speedStep = 15,
            ),
        )
        assertEquals(WakeWord.Custom, s.wakeWord)
        assertEquals("Hey Anemo", s.customWordName)
        assertEquals(Sensitivity.High, s.sensitivity)
        assertFalse(s.sounds)
        assertFalse(s.bluetoothMic)
        assertEquals("", s.ttsVoice)
        assertEquals(2.0f, s.ttsSpeed, 0.001f)
    }

    @Test
    fun `the saved voice is kept only when the phone still has it`() {
        assertEquals("en-gb-x-rjs-local", SettingsForm.voiceAfterLoading(saved, listOf("a", "en-gb-x-rjs-local")))
        assertEquals("", SettingsForm.voiceAfterLoading(saved, listOf("a")))
    }

    @Test
    fun `speed steps run from half to twice the normal speed`() {
        assertEquals(0, SettingsForm.speedStep(0.1f))
        assertEquals(5, SettingsForm.speedStep(1.0f))
        assertEquals(15, SettingsForm.speedStep(3.0f))
        assertEquals(0.5f, SettingsForm.speedOf(0), 0.001f)
        assertEquals(2.0f, SettingsForm.speedOf(15), 0.001f)
    }

    @Test
    fun `the form never prints the token`() {
        assertFalse(SettingsForm.from(saved).copy(token = "anemo_typed").toString().contains("anemo_typed"))
    }

    @Test
    fun `the models row`() {
        val ready = SettingsTexts.modelsRow(WakeWord.HeyJarvis, present = true, downloading = false)
        assertEquals("Models for Hey Jarvis: ready", ready.title)
        assertEquals(Tone.Ok, ready.tone)
        assertFalse(ready.canDownload)
        val missing = SettingsTexts.modelsRow(WakeWord.Alexa, present = false, downloading = false)
        assertEquals("Models not downloaded yet", missing.hint)
        assertTrue(missing.canDownload)
        val busy = SettingsTexts.modelsRow(WakeWord.Custom, present = false, downloading = true)
        assertEquals("Models for your own word", busy.title)
        assertEquals("Downloading…", busy.hint)
        assertFalse(busy.canDownload)
    }

    @Test
    fun `labels and message colours`() {
        assertEquals("Your own word", SettingsTexts.wordLabel(WakeWord.Custom))
        assertEquals("Hey Jarvis", SettingsTexts.wordLabel(WakeWord.HeyJarvis))
        assertEquals(Tone.Ok, SettingsTexts.messageTone("Saved."))
        assertEquals(Tone.Ok, SettingsTexts.messageTone("Saved. Start listening again to use the new settings."))
        assertEquals(Tone.Ok, SettingsTexts.messageTone("Downloaded."))
        assertEquals(Tone.Err, SettingsTexts.messageTone("Download failed: timeout"))
        assertEquals(Tone.Err, SettingsTexts.messageTone("Import failed: bad shape"))
        assertEquals(Tone.Err, SettingsTexts.messageTone(SettingsForm.BAD_ADDRESS))
        assertEquals(Tone.Neutral, SettingsTexts.messageTone("Downloading…"))
    }
}
