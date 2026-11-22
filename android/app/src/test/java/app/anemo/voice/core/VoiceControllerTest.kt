package app.anemo.voice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class VoiceControllerTest {
    private val wake = FakeWake()
    private val chimes = FakeChimes()
    private val speaker = FakeSpeaker()
    private val backend = FakeBackend()
    private val history = MemoryHistory()
    private val clock = FakeClock()
    private val states = mutableListOf<ListenState>()
    private lateinit var c: VoiceController

    @Before
    fun setUp() {
        c = VoiceController(
            wake, FakeVad(), chimes, speaker, backend, history, clock,
            chatLink = { "https://anemo.test/c/$it" },
            listener = object : VoiceController.Listener {
                override fun onStateChanged(state: ListenState) {
                    states += state
                }
            },
        )
        c.start()
    }

    private fun frames(make: () -> ShortArray, count: Int) = repeat(count) { c.onFrame(make()) }

    /** Wake word, half a second of speech, then silence until the recording ends. */
    private fun sayRequest() {
        c.onFrame(Frames.wake())
        speakThenStop()
    }

    private fun speakThenStop() {
        frames(Frames::speech, 6)
        frames(Frames::silence, 13) // 1040 ms of silence
    }

    private fun started(run: String = "r1", conv: String = "c1") =
        TurnResult.Started(run, conv, "uh mail tom no tim", "Email Tim.")

    private fun approval(kind: Approval.Kind, id: String = "a1", risk: String = "safe", steps: List<String> = emptyList()) =
        Approval(id, "r1", kind, "Send an email to Tim", risk, "Which day?", listOf("Monday", "Friday"), steps)

    // --- wake word, recording, upload -------------------------------------------------

    @Test
    fun `nothing is recorded or sent without the wake word`() {
        frames(Frames::speech, 50)
        assertTrue(backend.turns.isEmpty())
        assertEquals(ListenState.Listening, c.state)
        assertTrue(chimes.played.isEmpty())
    }

    @Test
    fun `wake word records until a second of silence and uploads a wav`() {
        c.onFrame(Frames.wake())
        assertEquals(ListenState.Recording, c.state)
        assertEquals(listOf("start"), chimes.played)
        frames(Frames::speech, 6)
        frames(Frames::silence, 12) // 960 ms: not yet
        assertTrue(backend.turns.isEmpty())
        c.onFrame(Frames.silence())
        assertEquals(1, backend.turns.size)
        assertEquals(listOf("start", "stop"), chimes.played)
        val turn = backend.turns[0]
        assertFalse(turn.status)
        assertNull(turn.conversationId)
        assertEquals("RIFF", String(turn.wav, 0, 4))
        // 6 speech + 13 silence frames, 2 bytes each, after the 44-byte header
        assertEquals(44 + 19 * AudioFormat16k.FRAME_SAMPLES * 2, turn.wav.size)
        assertEquals(ListenState.Listening, c.state)
    }

    @Test
    fun `a recording stops at sixty seconds`() {
        c.onFrame(Frames.wake())
        frames(Frames::speech, 60_000 / 80 - 1)
        assertTrue(backend.turns.isEmpty())
        c.onFrame(Frames.speech())
        assertEquals(1, backend.turns.size)
        assertEquals(44 + 60 * 16_000 * 2, backend.turns[0].wav.size)
    }

    @Test
    fun `no speech after the wake word sends nothing`() {
        c.onFrame(Frames.wake())
        frames(Frames::silence, 63) // 5040 ms
        assertTrue(backend.turns.isEmpty())
        assertEquals(ListenState.Listening, c.state)
        assertEquals(listOf("start", "stop"), chimes.played)
    }

    @Test
    fun `paused and stopped do not listen`() {
        c.pause()
        c.onFrame(Frames.wake())
        assertEquals(ListenState.Paused, c.state)
        c.resume()
        assertEquals(ListenState.Listening, c.state)
        c.stop()
        c.onFrame(Frames.wake())
        assertEquals(ListenState.Stopped, c.state)
        assertTrue(backend.turns.isEmpty())
    }

    @Test
    fun `the wake word is not heard while speaking`() {
        c.onEvent(DeviceEvent.VoiceSay("r1", "c1", "Done.", false))
        assertEquals(ListenState.Speaking, c.state)
        c.onFrame(Frames.wake())
        assertEquals(ListenState.Speaking, c.state)
    }

    // --- answers to a turn -------------------------------------------------------------

    @Test
    fun `a started run goes into the history with its chat link`() {
        sayRequest()
        backend.turns[0].onResult(started())
        val e = history.entries.single()
        assertEquals("uh mail tom no tim", e.heard)
        assertEquals("Email Tim.", e.request)
        assertEquals("https://anemo.test/c/c1", e.chatLink)
        assertNull(e.answer)
        assertTrue(speaker.spoken.isEmpty()) // nothing is said while the run works
    }

    @Test
    fun `the answer is spoken and kept in the history`() {
        sayRequest()
        backend.turns[0].onResult(started())
        c.onEvent(DeviceEvent.VoiceSay("r1", "c1", "I emailed Tim.", false))
        assertEquals(listOf("I emailed Tim."), speaker.spoken)
        assertEquals("I emailed Tim.", history.entries.single().answer)
        speaker.finish()
        assertEquals(ListenState.Listening, c.state)
    }

    @Test
    fun `cancelled says nothing`() {
        sayRequest()
        backend.turns[0].onResult(TurnResult.Cancelled)
        assertTrue(speaker.spoken.isEmpty())
        assertTrue(history.entries.isEmpty())
    }

    @Test
    fun `no transcription model is spoken with the setting's name`() {
        sayRequest()
        backend.turns[0].onResult(TurnResult.NoTranscriptionModel)
        assertTrue(speaker.spoken.single().contains("Transcription"))
        assertTrue(speaker.spoken.single().contains("Providers and Models"))
    }

    @Test
    fun `bad audio, a refused token and no connection are said`() {
        sayRequest()
        backend.turns[0].onResult(TurnResult.UnsupportedAudio)
        speaker.finish()
        backend.turns[0].onResult(TurnResult.Unauthorized)
        speaker.finish()
        backend.turns[0].onResult(TurnResult.Failed(null))
        assertEquals(listOf(Phrases.UNSUPPORTED_AUDIO, Phrases.UNAUTHORIZED, Phrases.UNREACHABLE), speaker.spoken)
    }

    @Test
    fun `the status command sends status and speaks the answer`() {
        c.requestStatus()
        val turn = backend.turns.single()
        assertTrue(turn.status)
        assertNull(turn.conversationId)
        turn.onResult(TurnResult.Say("Two runs are working."))
        assertEquals(listOf("Two runs are working."), speaker.spoken)
    }

    @Test
    fun `no status command while stopped`() {
        c.stop()
        c.requestStatus()
        assertTrue(backend.turns.isEmpty())
    }

    @Test
    fun `a new request can start while a run works`() {
        sayRequest()
        backend.turns[0].onResult(started())
        sayRequest()
        assertEquals(2, backend.turns.size)
    }

    // --- follow-up window --------------------------------------------------------------

    @Test
    fun `a request within five minutes of an answer continues the chat`() {
        c.onEvent(DeviceEvent.VoiceSay("r1", "c1", "Moved.", false))
        speaker.finish()
        clock.now += 5 * 60 * 1000
        sayRequest()
        assertEquals("c1", backend.turns.single().conversationId)
    }

    @Test
    fun `a request after the window starts a new chat`() {
        c.onEvent(DeviceEvent.VoiceSay("r1", "c1", "Moved.", false))
        speaker.finish()
        clock.now += 5 * 60 * 1000 + 1
        sayRequest()
        assertNull(backend.turns.single().conversationId)
    }

    // --- speech queue ------------------------------------------------------------------

    @Test
    fun `answers that arrive while recording wait their turn`() {
        c.onFrame(Frames.wake())
        c.onEvent(DeviceEvent.VoiceSay("r0", "c0", "Earlier answer.", false))
        assertTrue(speaker.spoken.isEmpty())
        speakThenStop()
        assertEquals(listOf("Earlier answer."), speaker.spoken)
    }

    @Test
    fun `answers are spoken one after the other`() {
        c.onEvent(DeviceEvent.VoiceSay("r1", "c1", "One.", false))
        c.onEvent(DeviceEvent.VoiceSay("r2", "c2", "Two.", false))
        assertEquals(listOf("One."), speaker.spoken)
        speaker.finish()
        assertEquals(listOf("One.", "Two."), speaker.spoken)
    }

    @Test
    fun `pause stops speaking`() {
        c.onEvent(DeviceEvent.VoiceSay("r1", "c1", "One.", false))
        c.pause()
        assertEquals(1, speaker.stops)
        assertEquals(ListenState.Paused, c.state)
    }

    @Test
    fun `run status is counted, never spoken`() {
        var active = -1
        c = VoiceController(
            wake, FakeVad(), chimes, speaker, backend, history, clock, { it },
            listener = object : VoiceController.Listener {
                override fun onActiveRunsChanged(count: Int) {
                    active = count
                }
            },
        )
        c.start()
        c.onEvent(DeviceEvent.RunStatus("r1", "running"))
        assertEquals(1, active)
        c.onEvent(DeviceEvent.RunStatus("r1", "completed"))
        assertEquals(0, active)
        assertTrue(speaker.spoken.isEmpty())
    }

    // --- approvals, questions, plans ----------------------------------------------------

    @Test
    fun `an approval is asked and the reply is sent without a wake word`() {
        c.onEvent(DeviceEvent.ApprovalRequested(approval(Approval.Kind.Action)))
        assertEquals(listOf("Send an email to Tim. Allow?"), speaker.spoken)
        speaker.finish()
        assertEquals(ListenState.Recording, c.state)
        speakThenStop()
        val reply = backend.replies.single()
        assertEquals("a1", reply.approvalId)
        assertTrue(backend.turns.isEmpty())
        reply.onResult(ReplyResult.Decided("approve", "yes"))
        assertEquals(1, speaker.spoken.size)
    }

    @Test
    fun `a question is read with its options`() {
        c.onEvent(DeviceEvent.ApprovalRequested(approval(Approval.Kind.Question)))
        assertEquals(listOf("Which day? The options are: Monday or Friday."), speaker.spoken)
        speaker.finish()
        speakThenStop()
        assertEquals("a1", backend.replies.single().approvalId)
    }

    @Test
    fun `a plan is read out and its review is sent`() {
        val steps = (1..8).map { "Step text $it" }
        c.onEvent(DeviceEvent.ApprovalRequested(approval(Approval.Kind.Plan, steps = steps)))
        val said = speaker.spoken.single()
        assertTrue(said.startsWith("Here is the plan."))
        assertTrue(said.contains("Step text 6."))
        assertFalse(said.contains("Step text 7"))
        assertTrue(said.endsWith("and 2 more. Go ahead?"))
        speaker.finish()
        speakThenStop()
        assertEquals("a1", backend.replies.single().approvalId)
    }

    @Test
    fun `a dangerous approval is never asked by voice`() {
        c.onEvent(DeviceEvent.ApprovalRequested(approval(Approval.Kind.Action, risk = "dangerous")))
        assertEquals(listOf("Send an email to Tim. That one needs a tap."), speaker.spoken)
        speaker.finish()
        assertEquals(ListenState.Listening, c.state)
        speakThenStop()
        assertTrue(backend.replies.isEmpty())
    }

    @Test
    fun `no reply within eight seconds leaves it to the notification`() {
        c.onEvent(DeviceEvent.ApprovalRequested(approval(Approval.Kind.Action)))
        speaker.finish()
        frames(Frames::silence, 8_000 / 80 - 1)
        assertEquals(ListenState.Recording, c.state)
        c.onFrame(Frames.silence())
        assertEquals(ListenState.Listening, c.state)
        assertTrue(backend.replies.isEmpty())
        assertEquals(1, speaker.spoken.size)
    }

    @Test
    fun `unclear asks once more, then leaves it to the notification`() {
        c.onEvent(DeviceEvent.ApprovalRequested(approval(Approval.Kind.Action)))
        speaker.finish()
        speakThenStop()
        backend.replies[0].onResult(ReplyResult.Unclear("hmm", "Sorry, was that a yes?"))
        assertEquals("Sorry, was that a yes?", speaker.spoken.last())
        speaker.finish()
        assertEquals(ListenState.Recording, c.state)
        speakThenStop()
        assertEquals(2, backend.replies.size)
        backend.replies[1].onResult(ReplyResult.Unclear("hmm", "Sorry, was that a yes?"))
        assertEquals(Phrases.USE_NOTIFICATION, speaker.spoken.last())
        speaker.finish()
        assertEquals(ListenState.Listening, c.state)
    }

    @Test
    fun `needs a tap is said`() {
        c.onEvent(DeviceEvent.ApprovalRequested(approval(Approval.Kind.Action)))
        speaker.finish()
        speakThenStop()
        backend.replies[0].onResult(ReplyResult.NeedsTap)
        assertEquals(Phrases.NEEDS_TAP, speaker.spoken.last())
    }

    @Test
    fun `already decided stops asking`() {
        c.onEvent(DeviceEvent.ApprovalRequested(approval(Approval.Kind.Action)))
        speaker.finish()
        speakThenStop()
        backend.replies[0].onResult(ReplyResult.AlreadyDecided)
        assertEquals(1, speaker.spoken.size)
        // the same approval sent again (after a reconnect) is not asked again
        c.onEvent(DeviceEvent.ApprovalRequested(approval(Approval.Kind.Action)))
        assertEquals(1, speaker.spoken.size)
    }

    @Test
    fun `decided elsewhere while it is being asked stops the speech`() {
        c.onEvent(DeviceEvent.ApprovalRequested(approval(Approval.Kind.Action)))
        c.onEvent(DeviceEvent.ApprovalDecided("a1", "approve"))
        assertEquals(1, speaker.stops)
        assertEquals(ListenState.Listening, c.state)
        speakThenStop()
        assertTrue(backend.replies.isEmpty())
    }

    @Test
    fun `decided elsewhere while listening for the reply drops the recording`() {
        c.onEvent(DeviceEvent.ApprovalRequested(approval(Approval.Kind.Action)))
        speaker.finish()
        frames(Frames::speech, 3)
        c.onEvent(DeviceEvent.ApprovalDecided("a1", "deny"))
        assertEquals(ListenState.Listening, c.state)
        frames(Frames::silence, 20)
        assertTrue(backend.replies.isEmpty())
    }

    @Test
    fun `decided elsewhere before its turn removes it from the queue`() {
        c.onEvent(DeviceEvent.VoiceSay("r0", "c0", "First.", false))
        c.onEvent(DeviceEvent.ApprovalRequested(approval(Approval.Kind.Action)))
        c.onEvent(DeviceEvent.ApprovalDecided("a1", "approve"))
        speaker.finish()
        assertEquals(listOf("First."), speaker.spoken)
        assertEquals(ListenState.Listening, c.state)
    }

    @Test
    fun `a failed reply upload is said`() {
        c.onEvent(DeviceEvent.ApprovalRequested(approval(Approval.Kind.Question)))
        speaker.finish()
        speakThenStop()
        backend.replies[0].onResult(ReplyResult.Failed(500))
        assertTrue(speaker.spoken.last().contains(Phrases.USE_NOTIFICATION))
    }

    @Test
    fun `states are reported`() {
        sayRequest()
        assertEquals(listOf(ListenState.Listening, ListenState.Recording, ListenState.Listening), states)
    }
}
