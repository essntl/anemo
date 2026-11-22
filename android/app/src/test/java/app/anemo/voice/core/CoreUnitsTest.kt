package app.anemo.voice.core

import app.anemo.voice.net.Backoff
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.random.Random

class CoreUnitsTest {
    @Test
    fun `wav header is 16 kHz mono 16-bit PCM`() {
        val wav = Wav.encode(shortArrayOf(1, -1, 32767))
        val b = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN)
        assertEquals("RIFF", String(wav, 0, 4))
        assertEquals(36 + 6, b.getInt(4))
        assertEquals("WAVE", String(wav, 8, 4))
        assertEquals("fmt ", String(wav, 12, 4))
        assertEquals(1, b.getShort(20).toInt()) // PCM
        assertEquals(1, b.getShort(22).toInt()) // mono
        assertEquals(16_000, b.getInt(24))
        assertEquals(32_000, b.getInt(28))
        assertEquals(16, b.getShort(34).toInt())
        assertEquals("data", String(wav, 36, 4))
        assertEquals(6, b.getInt(40))
        assertEquals(-1, b.getShort(46).toInt())
        assertEquals(32767, b.getShort(48).toInt())
    }

    @Test
    fun `endpointer waits for speech, then a second of silence`() {
        val e = Endpointer(silenceMs = 1_000, maxMs = 60_000, noSpeechMs = 5_000)
        repeat(10) { assertEquals(Endpointer.Result.Continue, e.update(0.1f)) }
        assertEquals(Endpointer.Result.Continue, e.update(0.9f))
        repeat(12) { assertEquals(Endpointer.Result.Continue, e.update(0.1f)) }
        // a word in between resets the silence
        assertEquals(Endpointer.Result.Continue, e.update(0.8f))
        repeat(12) { assertEquals(Endpointer.Result.Continue, e.update(0.1f)) }
        assertEquals(Endpointer.Result.End, e.update(0.1f))
    }

    @Test
    fun `endpointer: between the thresholds is neither speech nor silence`() {
        val e = Endpointer(silenceMs = 160)
        e.update(0.9f)
        repeat(10) { assertEquals(Endpointer.Result.Continue, e.update(0.4f)) }
        e.update(0.1f)
        assertEquals(Endpointer.Result.End, e.update(0.1f))
    }

    @Test
    fun `recording buffer stops at its limit`() {
        val b = RecordingBuffer(maxSamples = 3_000)
        repeat(5) { b.add(ShortArray(1_280) { 1 }) }
        assertEquals(3_000, b.size)
        assertEquals(3_000, b.samples().size)
    }

    @Test
    fun `follow-up window`() {
        val clock = FakeClock(0)
        val w = FollowUpWindow(clock, 1_000)
        assertNull(w.conversationForNewRequest())
        w.answered("c1")
        clock.now = 1_000
        assertEquals("c1", w.conversationForNewRequest())
        clock.now = 1_001
        assertNull(w.conversationForNewRequest())
        w.answered("c2")
        assertEquals("c2", w.conversationForNewRequest())
    }

    @Test
    fun `phrases`() {
        val a = Approval("a", "r", Approval.Kind.Action, "Delete the draft", "safe")
        assertEquals("Delete the draft. Allow?", Phrases.ask(a))
        assertEquals("Delete the draft. That one needs a tap.", Phrases.dangerous(a.copy(risk = "dangerous")))
        val q = a.copy(kind = Approval.Kind.Question, question = "Which one?", options = listOf("A", "B", "C"))
        assertEquals("Which one? The options are: A, B, or C.", Phrases.ask(q))
        assertEquals("Which one?", Phrases.ask(q.copy(options = emptyList())))
        assertEquals("Here is the plan. Step 1: One. Step 2: Two! Go ahead?", Phrases.plan(listOf("One", "Two!")))
        val seven = Phrases.plan((1..7).map { "S$it" })
        assertTrue(seven, seven.endsWith("Step 6: S6. and 1 more. Go ahead?"))
    }

    @Test
    fun `back-off doubles up to its maximum`() {
        val b = Backoff(initialMs = 1_000, maxMs = 60_000, random = Random(3))
        val delays = (1..10).map { b.next() }
        assertTrue(delays.toString(), delays[0] in 800..1_200)
        assertTrue(delays.toString(), delays[1] in 1_600..2_400)
        assertTrue(delays.toString(), delays.last() in 48_000..72_000)
        b.reset()
        assertTrue(b.next() in 800..1_200)
    }
}
