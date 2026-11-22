package app.anemo.voice.core

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.Callable
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

class VoiceSessionTest {
    private val voice = Executors.newSingleThreadScheduledExecutor()
    private val fatal = LinkedBlockingQueue<String>()
    private val events = LinkedBlockingQueue<String>()

    private inner class FakeMic : Microphone {
        var failOpen = false
        var opens = 0
        @Volatile var onFrame: ((ShortArray) -> Unit)? = null
        @Volatile var onError: ((String) -> Unit)? = null

        override fun open(onFrame: (ShortArray) -> Unit, onError: (String) -> Unit) {
            opens++
            if (failOpen) {
                events.add("mic open")
                throw IllegalStateException("busy")
            }
            // Before the test hears "mic open": it uses these right after.
            this.onFrame = onFrame
            this.onError = onError
            events.add("mic open")
        }

        override fun close() {
            events.add("mic close")
            onFrame = null
        }
    }

    private val mic = FakeMic()
    private val connection = object : Connection {
        override fun start() {
            events.add("connect")
        }
        override fun stop() {
            events.add("disconnect")
        }
    }

    private fun controller(wake: WakeWordDetector = FakeWake()) = VoiceController(
        wake, FakeVad(), FakeChimes(), FakeSpeaker(), FakeBackend(), MemoryHistory(),
        FakeClock(), FakeClock(), ExecutorTimer(voice), { it },
    )

    private fun session(c: VoiceController, retries: List<Long> = listOf(10, 10)) = VoiceSession(
        voice, c, mic, connection,
        onFatal = { fatal.add(it) },
        cleanup = listOf({ events.add("cleanup") }),
        retryDelaysMs = retries,
    )

    private fun <T> onVoice(block: () -> T): T = voice.submit(Callable { block() }).get(5, TimeUnit.SECONDS)

    private fun await(what: String) {
        while (true) {
            val e = checkNotNull(events.poll(5, TimeUnit.SECONDS)) { "no $what" }
            if (e == what) return
        }
    }

    @After
    fun tearDown() {
        voice.shutdownNow()
    }

    @Test
    fun `frames reach the voice loop`() {
        val c = controller()
        session(c).start()
        await("connect")
        await("mic open")
        mic.onFrame!!(Frames.wake())
        onVoice { }
        assertEquals(ListenState.Recording, onVoice { c.state })
    }

    @Test
    fun `a microphone that can't open stops everything and says why`() {
        mic.failOpen = true
        val c = controller()
        session(c).start()
        val message = fatal.poll(5, TimeUnit.SECONDS)!!
        assertTrue(message, message.contains("microphone could not be opened"))
        await("disconnect")
        await("cleanup")
        assertTrue(voice.awaitTermination(2, TimeUnit.SECONDS))
    }

    @Test
    fun `a read error reopens the microphone, then gives up`() {
        val c = controller()
        session(c).start()
        await("mic open")
        mic.onError!!("read error -3")
        await("mic close")
        await("mic open") // after 10 ms
        mic.onError!!("read error -3")
        await("mic open")
        mic.onError!!("read error -3")
        val message = fatal.poll(5, TimeUnit.SECONDS)!!
        assertTrue(message, message.contains("stopped working"))
        await("cleanup")
        assertEquals(3, mic.opens)
    }

    @Test
    fun `a failing wake word engine stops listening with an error`() {
        val broken = object : WakeWordDetector {
            override fun process(frame: ShortArray): Boolean = throw IllegalStateException("model broke")
            override fun reset() = Unit
        }
        val c = controller(broken)
        session(c).start()
        await("mic open")
        mic.onFrame!!(Frames.silence())
        val message = fatal.poll(5, TimeUnit.SECONDS)!!
        assertTrue(message, message.contains("model broke"))
        await("cleanup")
    }

    @Test
    fun `when the engines fall behind, the oldest frames are dropped`() {
        val c = controller()
        val s = session(c)
        s.start()
        await("mic open")
        onVoice { }
        val gate = CountDownLatch(1)
        voice.execute { gate.await() } // the voice thread is busy
        repeat(30) { mic.onFrame!!(Frames.silence()) }
        assertEquals(5, s.droppedFrames)
        gate.countDown()
        onVoice { }
    }

    @Test
    fun `pause releases the microphone, resume opens it, stop cleans up once`() {
        val c = controller()
        val s = session(c)
        s.start()
        await("mic open")
        s.pause()
        await("mic close")
        assertEquals(ListenState.Paused, onVoice { c.state })
        s.resume()
        await("mic open")
        assertEquals(ListenState.Listening, onVoice { c.state })
        s.stop()
        s.stop()
        await("disconnect")
        await("mic close")
        await("cleanup")
        assertTrue(voice.awaitTermination(2, TimeUnit.SECONDS))
        assertFalse(events.contains("cleanup"))
        assertEquals(ListenState.Stopped, c.state)
    }
}
