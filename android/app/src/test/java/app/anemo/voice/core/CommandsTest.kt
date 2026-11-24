package app.anemo.voice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CommandsTest {
    private fun match(heard: String, on: Boolean = false, startPhrase: Boolean = true, wake: String = "Hey Jarvis") =
        Commands.match(heard, wake, voiceModeOn = on, startPhrase = startPhrase)

    @Test
    fun `start voice mode, however it is written`() {
        for (heard in listOf(
            "start voice mode",
            "Start voice mode.",
            "START VOICE MODE!",
            "Start, voice mode",
            "Please start voice mode.",
            "OK, start the voice mode now",
            "Turn on voice mode.",
            "Voice mode on",
            "Enable voice mode",
            "Begin voice mode",
        )) {
            assertEquals(heard, Command.StartVoiceMode, match(heard))
        }
    }

    @Test
    fun `right after the wake word, in the same breath`() {
        for (heard in listOf(
            "Hey Jarvis, start voice mode.",
            "Jarvis start voice mode",
            "Hey Jervis, start voice mode", // one letter off
            "…vis, start voice mode", // the recording began inside the wake word
            "hey jarvis please start voice mode",
        )) {
            assertEquals(heard, Command.StartVoiceMode, match(heard))
        }
        assertEquals(Command.StartVoiceMode, match("Alexa, start voice mode", wake = "Alexa"))
    }

    @Test
    fun `one misheard word, if it is close`() {
        assertEquals(Command.StartVoiceMode, match("Start voice mood."))
        assertEquals(Command.StartVoiceMode, match("Start choice mode."))
        assertEquals(Command.StopVoiceMode, match("End voice mood", on = true))
        // not close: an ordinary request
        assertNull(match("Start voice memo"))
        assertNull(match("Start voice recording"))
        // two words wrong
        assertNull(match("Start choice mood"))
    }

    @Test
    fun `only the whole utterance counts`() {
        assertNull(match("start voice mode and tell me the weather"))
        assertNull(match("can you start voice mode"))
        assertNull(match("what is voice mode"))
        assertNull(match("stop the music", on = true))
        assertNull(match("don't stop", on = true))
        assertNull(match(""))
        assertNull(match("Hey Jarvis."))
    }

    @Test
    fun `stop only while voice mode is on, and only on its own`() {
        assertEquals(Command.StopVoiceMode, match("Stop.", on = true))
        assertEquals(Command.StopVoiceMode, match("Stop, please.", on = true))
        assertEquals(Command.StopVoiceMode, match("Hey Jarvis, stop.", on = true))
        assertEquals(Command.StopVoiceMode, match("End voice mode.", on = true))
        assertEquals(Command.StopVoiceMode, match("Exit voice mode", on = true))
        assertEquals(Command.StopVoiceMode, match("Turn off voice mode", on = true))
        assertEquals(Command.StopVoiceMode, match("Voice mode off", on = true))
        assertEquals(Command.StopVoiceMode, match("Stop voice mode", on = true))
        // a short phrase must match exactly
        assertNull(match("Stab.", on = true))
        // ordinary words never end it
        assertNull(match("That's all, thanks.", on = true))
        // while off, "stop" is an ordinary request
        assertNull(match("Stop."))
        assertNull(match("End voice mode."))
    }

    @Test
    fun `stop voice mode is never taken for start, even while only starting counts`() {
        assertNull(match("Stop voice mode"))
        assertNull(match("Turn off voice mode"))
        assertEquals(Command.StopVoiceMode, match("Stop voice mode", on = true))
    }

    @Test
    fun `a misheard word as close to on as to off matches nothing`() {
        assertEquals(Command.StartVoiceMode, match("Turn on voice mode", on = true))
        assertEquals(Command.StopVoiceMode, match("Turn off voice mode", on = true))
        assertNull(match("Turn of voice mode", on = true)) // "of": one letter from both
    }

    @Test
    fun `the start phrase can be switched off, but while on it always opens the microphone`() {
        assertNull(match("Start voice mode", startPhrase = false))
        assertEquals(Command.StartVoiceMode, match("Start voice mode", on = true, startPhrase = false))
    }

    @Test
    fun `a request loses the wake word at its start, and nothing else`() {
        assertEquals("what's on tomorrow?", Commands.request("Hey Jarvis, what's on tomorrow?", "Hey Jarvis"))
        assertEquals("What's on tomorrow?", Commands.request("…vis. What's on tomorrow?", "Hey Jarvis"))
        assertEquals("add milk.", Commands.request("Jarvis add milk.", "Hey Jarvis")) // the server tidies it
        assertEquals("Add milk.", Commands.request("Add milk.", "Hey Jarvis"))
        assertEquals("Is it raining?", Commands.request("Is it raining?", "Hey Jarvis")) // "is" isn't "…vis"
        assertEquals("Tell Jarvis hello.", Commands.request("Tell Jarvis hello.", "Hey Jarvis"))
        assertEquals("", Commands.request("Hey Jarvis.", "Hey Jarvis"))
        assertEquals("Add milk.", Commands.request("Add milk.", ""))
    }

    @Test
    fun `words and edit distance`() {
        assertEquals(listOf("whats", "on", "tomorrow"), Commands.words("What's on — tomorrow?!"))
        assertEquals(listOf("whats"), Commands.words("What’s"))
        assertEquals(0, Commands.editDistance("mode", "mode"))
        assertEquals(1, Commands.editDistance("mode", "node"))
        assertEquals(2, Commands.editDistance("mode", "mood"))
        assertEquals(3, Commands.editDistance("stop", "start"))
        assertEquals(4, Commands.editDistance("", "mode"))
    }
}
