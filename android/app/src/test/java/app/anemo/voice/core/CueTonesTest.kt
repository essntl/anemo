package app.anemo.voice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

class CueTonesTest {
    @Test
    fun `lengths as the spec says`() {
        assertEquals(140, CueTones.durationMs(Cue.Start))
        assertEquals(140, CueTones.durationMs(Cue.End))
        assertEquals(260, CueTones.durationMs(Cue.Timeout))
        assertEquals(300, CueTones.durationMs(Cue.VoiceModeOn))
        assertEquals(300, CueTones.durationMs(Cue.VoiceModeOff))
        for (cue in Cue.entries) {
            assertEquals(cue.name, CueTones.SAMPLE_RATE * CueTones.durationMs(cue) / 1000, CueTones.pcm(cue).size)
        }
    }

    @Test
    fun `start, end and timeout sound different, and so do on and off`() {
        val heard = listOf(Cue.Start, Cue.End, Cue.Timeout, Cue.Reply, Cue.VoiceModeOn, Cue.VoiceModeOff)
        assertEquals(heard.size, heard.map { CueTones.notes(it) }.toSet().size)
        // start rises, end falls
        val start = CueTones.notes(Cue.Start).filter { it.hz > 0 }
        val end = CueTones.notes(Cue.End).filter { it.hz > 0 }
        assertTrue(start.first().hz < start.last().hz)
        assertTrue(end.first().hz > end.last().hz)
        assertEquals(CueTones.notes(Cue.Start), CueTones.notes(Cue.Reopen)) // the reopen is the start sound
        assertFalse(CueTones.vibration(Cue.Start).contentEquals(CueTones.vibration(Cue.Timeout)))
        assertFalse(CueTones.vibration(Cue.VoiceModeOn).contentEquals(CueTones.vibration(Cue.VoiceModeOff)))
    }

    @Test
    fun `no clicks and no clipping`() {
        for (cue in Cue.entries) {
            val pcm = CueTones.pcm(cue)
            assertTrue(cue.name, abs(pcm.first().toInt()) < 200 && abs(pcm.last().toInt()) < 200)
            assertTrue(cue.name, pcm.maxOf { abs(it.toInt()) } < Short.MAX_VALUE * 0.5)
            assertTrue(cue.name, pcm.maxOf { abs(it.toInt()) } > Short.MAX_VALUE * 0.3) // audible
        }
    }

    @Test
    fun `vibration patterns start with a pause and are short`() {
        for (cue in Cue.entries) {
            val v = CueTones.vibration(cue)
            assertEquals(0L, v.first())
            assertTrue(cue.name, v.sum() <= 400)
        }
    }

    @Test
    fun `only the start, end and timeout sounds can be switched off`() {
        assertEquals(setOf(Cue.Start, Cue.End, Cue.Timeout), Cue.entries.filter { it.optional }.toSet())
    }
}
