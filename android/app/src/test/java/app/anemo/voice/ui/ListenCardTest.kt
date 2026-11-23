package app.anemo.voice.ui

import app.anemo.voice.core.ListenState
import app.anemo.voice.service.Connection
import app.anemo.voice.service.Status
import app.anemo.voice.service.StatusText
import app.anemo.voice.settings.Problem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ListenCardTest {
    private val connected = Connection.Connected("Phone")

    private fun card(status: Status, notSetUp: Boolean = false) = ListenCards.of(status, "Hey Jarvis", notSetUp)

    @Test
    fun `not listening offers only Start, and says when it isn't set up`() {
        val c = card(Status(), notSetUp = true)
        assertEquals("Not listening", c.title)
        assertEquals(Toned("Not set up", Tone.Neutral), c.chip)
        assertEquals(TileKind.Off, c.tile)
        assertEquals(listOf(CardButton(CardAction.Start, primary = true)), c.buttons)
        assertNull(c.detail)
    }

    @Test
    fun `not listening and set up has no chip, and shows why it stopped`() {
        val c = card(Status(error = "Android didn't allow listening to start here."))
        assertNull(c.chip)
        assertEquals(Toned("Android didn't allow listening to start here.", Tone.Err), c.detail)
    }

    @Test
    fun `listening names the wake word and offers Stop, Pause and Status`() {
        val c = card(Status(listen = ListenState.Listening, connection = connected))
        assertEquals("Listening for “Hey Jarvis”", c.title)
        assertEquals(Toned("Connected", Tone.Ok), c.chip)
        assertEquals(TileKind.Listening, c.tile)
        assertEquals(listOf(CardAction.Stop, CardAction.Pause, CardAction.Status), c.buttons.map { it.action })
        assertTrue(c.buttons.none { it.primary })
    }

    @Test
    fun `recording and speaking have their own titles and tiles`() {
        val rec = card(Status(listen = ListenState.Recording, connection = connected, activeRuns = 1))
        assertEquals("Listening to you", rec.title)
        assertEquals(TileKind.Recording, rec.tile)
        assertEquals("Connected · 1 request working", rec.chip?.text)
        val speak = card(Status(listen = ListenState.Speaking, connection = connected, activeRuns = 2))
        assertEquals("Anemo is speaking", speak.title)
        assertEquals(TileKind.Speaking, speak.tile)
        assertEquals("Connected · 2 requests working", speak.chip?.text)
    }

    @Test
    fun `paused makes Resume the primary button and says the wake word is off`() {
        val c = card(Status(listen = ListenState.Paused, connection = connected))
        assertEquals("Paused", c.title)
        assertEquals(TileKind.Paused, c.tile)
        assertEquals(Toned(ListenCards.PAUSED_DETAIL, Tone.Neutral), c.detail)
        assertEquals(CardButton(CardAction.Resume, primary = true), c.buttons.first())
        assertEquals(listOf(CardAction.Resume, CardAction.Stop, CardAction.Status), c.buttons.map { it.action })
    }

    @Test
    fun `a notice is shown under the chip`() {
        val c = card(Status(listen = ListenState.Listening, connection = connected, notice = "No speech engine"))
        assertEquals(Toned("No speech engine", Tone.Neutral), c.detail)
    }

    @Test
    fun `the chip follows the connection`() {
        fun chip(c: Connection) = ListenCards.chip(Status(listen = ListenState.Listening, connection = c))
        assertEquals(Toned("Connecting to Anemo…", Tone.Neutral), chip(Connection.Connecting))
        assertEquals(Toned("Can't reach Anemo, trying again in 8 s", Tone.Err), chip(Connection.Retrying(8)))
        assertEquals(Toned("The device was removed", Tone.Err), chip(Connection.Refused("The device was removed")))
        assertEquals(Toned("Connected", Tone.Ok), chip(Connection.Off))
    }

    @Test
    fun `an error wins over the connection`() {
        val s = Status(listen = ListenState.Listening, connection = connected, error = "Microphone lost")
        assertEquals(Toned("Microphone lost", Tone.Err), ListenCards.chip(s))
    }

    @Test
    fun `only problems fixed in Settings offer the Settings button`() {
        assertTrue(ListenCards.problemLine(Problem.NoAddress).opensSettings)
        assertTrue(ListenCards.problemLine(Problem.NoWakeWordModel).opensSettings)
        assertFalse(ListenCards.problemLine(Problem.NoMicrophone).opensSettings)
        assertFalse(ListenCards.problemLine(Problem.NoNotifications).opensSettings)
        assertEquals(Problem.NoToken.message, ListenCards.problemLine(Problem.NoToken).text)
        assertTrue(ListenCards.problemLine(Problem.NoToken).fromSetup)
    }

    @Test
    fun `the empty history names the wake word`() {
        assertEquals(
            "Say “Hey Anemo”, then what you want. Answers are spoken and kept here, with a link to the chat.",
            ListenCards.emptyHistory("Hey Anemo"),
        )
    }

    @Test
    fun `the shared status words`() {
        assertNull(StatusText.connection(connected))
        assertNull(StatusText.connection(Connection.Off))
        assertNull(StatusText.activeRuns(0))
        assertEquals("1 request working", StatusText.activeRuns(1))
        assertEquals("3 requests working", StatusText.activeRuns(3))
    }
}
