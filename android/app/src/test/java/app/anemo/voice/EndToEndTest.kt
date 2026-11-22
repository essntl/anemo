package app.anemo.voice

import app.anemo.voice.core.Chimes
import app.anemo.voice.core.ExecutorTimer
import app.anemo.voice.core.DeviceEvent
import app.anemo.voice.core.FakeVad
import app.anemo.voice.core.FakeWake
import app.anemo.voice.core.Frames
import app.anemo.voice.core.ListenState
import app.anemo.voice.core.MemoryHistory
import app.anemo.voice.core.Phrases
import app.anemo.voice.core.PostingBackend
import app.anemo.voice.core.Speaker
import app.anemo.voice.core.VoiceController
import app.anemo.voice.net.DeviceSocket
import app.anemo.voice.net.FakeAnemo
import app.anemo.voice.net.VoiceApi
import okhttp3.OkHttpClient
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * The whole phone side against a fake Anemo that speaks docs/device-contracts.md: the
 * voice loop on its own thread, the real HTTP client, the real WebSocket client. Only the
 * microphone, the wake word and VAD engines and the speech engine are fakes.
 */
class EndToEndTest {
    private val fake = FakeAnemo()
    private val client = OkHttpClient()
    private val voice = Executors.newSingleThreadScheduledExecutor()
    private val socketThread = Executors.newSingleThreadScheduledExecutor()
    private val spoken = LinkedBlockingQueue<String>()
    private val history = MemoryHistory()

    /** Speaks instantly: done right after the current step of the voice loop. */
    private val speaker = object : Speaker {
        override fun speak(text: String, onDone: (completed: Boolean) -> Unit) {
            spoken.add(text)
            voice.execute { onDone(true) }
        }
        override fun stop() = Unit
    }

    private val controller = VoiceController(
        FakeWake(), FakeVad(), object : Chimes {
            override fun start() = Unit
            override fun stop() = Unit
            override fun reply() = Unit
        },
        speaker,
        PostingBackend(VoiceApi(client, fake.address, fake.token), voice),
        history,
        clock = { System.currentTimeMillis() },
        monotonic = { System.nanoTime() / 1_000_000 },
        timer = ExecutorTimer(voice),
        chatLink = fake.address::chat,
    )

    private val socket = DeviceSocket(
        client, fake.address.deviceSocket, fake.token, "1.0.0",
        object : DeviceSocket.Listener {
            override fun onEvent(event: DeviceEvent) = voice.execute { controller.onEvent(event) }
        },
        socketThread,
    )

    private val conn: FakeAnemo.Connection

    init {
        onVoice { controller.start() }
        socket.start()
        conn = fake.nextConnection()
        assertEquals("hello", fake.received.poll(5, TimeUnit.SECONDS)!!.getString("type"))
    }

    @After
    fun tearDown() {
        socket.stop()
        voice.shutdown()
        socketThread.shutdown()
        fake.close()
    }

    private fun <T> onVoice(block: () -> T): T = voice.submit(Callable { block() }).get(5, TimeUnit.SECONDS)

    private fun feed(vararg frames: ShortArray) = frames.forEach { f -> voice.execute { controller.onFrame(f) } }

    /** Speech, then a second of silence: the recording ends and is sent. */
    private fun speak() {
        feed(*Array(6) { Frames.speech() })
        feed(*Array(13) { Frames.silence() })
    }

    private fun request() {
        feed(Frames.wake())
        speak()
    }

    private fun nextSpoken(): String = checkNotNull(spoken.poll(5, TimeUnit.SECONDS)) { "nothing was said" }

    private fun awaitState(state: ListenState) {
        val until = System.currentTimeMillis() + 5_000
        while (onVoice { controller.state } != state) {
            check(System.currentTimeMillis() < until) { "never $state" }
            Thread.sleep(10)
        }
    }

    private fun approval(id: String, kind: String, risk: String = "safe") = JSONObject()
        .put("approval_id", id).put("run_id", "r1").put("kind", kind).put("summary", "Send the email to Tim").put("risk", risk)

    @Test
    fun `wake word, request, run, spoken answer, and a follow-up in the same chat`() {
        request()
        val up = fake.nextUpload()
        assertEquals("/api/voice/turns", up.path)
        assertNull(up.parts["conversation_id"])
        awaitHistory()
        assertEquals(fake.address.chat("c1"), history.entries.single().chatLink)

        conn.event("e1", "run.status", JSONObject().put("run_id", "r1").put("status", "running"))
        conn.event(
            "e2", "voice.say",
            JSONObject().put("run_id", "r1").put("conversation_id", "c1").put("text", "I emailed Tim.").put("more", false),
        )
        assertEquals("I emailed Tim.", nextSpoken())
        awaitState(ListenState.Listening)
        assertEquals("I emailed Tim.", onVoice { history.entries.single().answer })

        request()
        assertEquals("c1", fake.nextUpload().parts.getValue("conversation_id").text)
    }

    private fun awaitHistory() {
        val until = System.currentTimeMillis() + 5_000
        while (onVoice { history.entries.isEmpty() }) {
            check(System.currentTimeMillis() < until) { "no history entry" }
            Thread.sleep(10)
        }
    }

    @Test
    fun `no transcription model, the server's message is said`() {
        fake.turnResponse = FakeAnemo.error(409, "no_transcription_model", "Choose a Transcription model in Settings, Providers and Models.")
        request()
        assertEquals("Choose a Transcription model in Settings, Providers and Models.", nextSpoken())
    }

    @Test
    fun `a 422 is said in the server's words`() {
        fake.turnResponse = FakeAnemo.error(422, "audio_too_large", "That recording is too long.")
        request()
        assertEquals("That recording is too long.", nextSpoken())
    }

    @Test
    fun `nothing heard is said`() {
        fake.turnResponse = FakeAnemo.json(200, """{"say":"Sorry, I didn't catch that."}""")
        request()
        assertEquals("Sorry, I didn't catch that.", nextSpoken())
    }

    @Test
    fun `an answer after stop is dropped, not a crash`() {
        val latch = java.util.concurrent.CountDownLatch(1)
        fake.turnResponse = FakeAnemo.json(202, FakeAnemo.TURN_STARTED).setBodyDelay(300, TimeUnit.MILLISECONDS)
        val errors = mutableListOf<Throwable>()
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { _, e -> synchronized(errors) { errors += e } }
        try {
            request()
            fake.nextUpload()
            voice.shutdown() // the service stopped while the upload was in flight
            latch.await(800, TimeUnit.MILLISECONDS)
            assertTrue(errors.toString(), errors.isEmpty())
        } finally {
            Thread.setDefaultUncaughtExceptionHandler(previous)
        }
    }

    @Test
    fun `an approval is allowed by voice`() {
        conn.event("e1", "approval.requested", approval("a1", "action"))
        assertEquals("Send the email to Tim. Allow?", nextSpoken())
        awaitState(ListenState.Recording)
        speak()
        val up = fake.nextUpload()
        assertEquals("/api/voice/replies", up.path)
        assertEquals("a1", up.parts.getValue("approval_id").text)
        assertEquals("Bearer ${fake.token}", up.headers["Authorization"])
    }

    @Test
    fun `a question is answered by voice`() {
        conn.event(
            "e1", "approval.requested",
            approval("q1", "question").put("question", "Which Tim?").put("options", JSONArray(listOf("Tim Berg", "Tim Ost"))),
        )
        assertEquals("Which Tim? The options are: Tim Berg or Tim Ost.", nextSpoken())
        awaitState(ListenState.Recording)
        speak()
        assertEquals("q1", fake.nextUpload().parts.getValue("approval_id").text)
    }

    @Test
    fun `a plan is read out and accepted by voice`() {
        val steps = JSONArray((1..9).map { "Do thing $it" })
        conn.event("e1", "approval.requested", approval("p1", "plan").put("steps", steps))
        val said = nextSpoken()
        assertTrue(said, said.startsWith("Here is the plan. Step 1: Do thing 1."))
        assertTrue(said, said.endsWith("Step 6: Do thing 6. and 3 more. Go ahead?"))
        awaitState(ListenState.Recording)
        speak()
        assertEquals("p1", fake.nextUpload().parts.getValue("approval_id").text)
    }

    @Test
    fun `a dangerous one is not asked by voice and says why`() {
        conn.event("e1", "approval.requested", approval("d1", "action", risk = "dangerous"))
        assertEquals("Send the email to Tim. That one needs a tap.", nextSpoken())
        awaitState(ListenState.Listening)
        speak()
        Thread.sleep(200)
        assertTrue(fake.uploads.isEmpty())
    }

    @Test
    fun `the server saying needs a tap is said`() {
        fake.replyResponse = FakeAnemo.json(409, """{"error":{"code":"needs_tap"}}""")
        conn.event("e1", "approval.requested", approval("a1", "action"))
        nextSpoken()
        awaitState(ListenState.Recording)
        speak()
        assertEquals(Phrases.NEEDS_TAP, nextSpoken())
    }

    @Test
    fun `unclear is asked once more, then left to the notification`() {
        fake.replyResponse = FakeAnemo.json(200, """{"decided":null,"heard":"hmm","say":"Sorry, was that a yes?"}""")
        conn.event("e1", "approval.requested", approval("a1", "action"))
        nextSpoken()
        awaitState(ListenState.Recording)
        speak()
        assertEquals("Sorry, was that a yes?", nextSpoken())
        awaitState(ListenState.Recording)
        speak()
        assertEquals(Phrases.USE_NOTIFICATION, nextSpoken())
        assertEquals(2, fake.uploads.size)
    }

    @Test
    fun `decided elsewhere stops asking`() {
        conn.event("e1", "approval.requested", approval("a1", "action"))
        nextSpoken()
        awaitState(ListenState.Recording)
        conn.event("e2", "approval.decided", JSONObject().put("approval_id", "a1").put("decision", "approve"))
        awaitState(ListenState.Listening)
        speak()
        Thread.sleep(200)
        assertTrue(fake.uploads.isEmpty())
        assertFalse(spoken.isNotEmpty())
    }

    @Test
    fun `the status command`() {
        fake.statusSay = "One run is working: the email to Tim."
        onVoice { controller.requestStatus() }
        val up = fake.nextUpload()
        assertEquals("true", up.parts.getValue("status").text)
        assertFalse(up.parts.containsKey("audio"))
        assertEquals("One run is working: the email to Tim.", nextSpoken())
    }
}
