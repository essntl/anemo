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
    private val mono = FakeClock(0)
    private val timer = FakeTimer()
    private val states = mutableListOf<ListenState>()
    private lateinit var c: VoiceController

    @Before
    fun setUp() {
        c = VoiceController(
            wake, FakeVad(), chimes, speaker, backend, history, clock, mono, timer,
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

    private fun approval(
        kind: Approval.Kind,
        id: String = "a1",
        risk: String? = "safe",
        steps: List<String> = emptyList(),
        run: String = "r1",
    ) = Approval(id, run, kind, "Send an email to Tim", risk, "Which day?", listOf("Monday", "Friday"), steps)

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
        assertEquals("RIFF", String(turn.wav!!, 0, 4))
        // 6 speech + 13 silence frames, 2 bytes each, after the 44-byte header
        assertEquals(44 + 19 * AudioFormat16k.FRAME_SAMPLES * 2, turn.wav!!.size)
        assertEquals(ListenState.Listening, c.state)
    }

    @Test
    fun `a recording stops at sixty seconds`() {
        c.onFrame(Frames.wake())
        frames(Frames::speech, 60_000 / 80 - 1)
        assertTrue(backend.turns.isEmpty())
        c.onFrame(Frames.speech())
        assertEquals(1, backend.turns.size)
        assertEquals(44 + 60 * 16_000 * 2, backend.turns[0].wav!!.size)
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
        backend.turns[0].onResult(TurnResult.Refused(ServerError(409, "no_transcription_model", null)))
        assertTrue(speaker.spoken.single().contains("Transcription"))
        assertTrue(speaker.spoken.single().contains("Providers and Models"))
    }

    @Test
    fun `the server's message is said, the phone's own phrase only without one`() {
        sayRequest()
        val result = backend.turns[0].onResult
        result(TurnResult.Refused(ServerError(422, "audio_too_large", "That recording is too long.")))
        speaker.finish()
        result(TurnResult.Refused(ServerError(409, "no_transcription_model", "Choose a Transcription model first.")))
        speaker.finish()
        result(TurnResult.Refused(ServerError(413, null, null))) // a proxy's HTML page
        speaker.finish()
        result(TurnResult.Unauthorized(ServerError(401, "unauthorized", "Not signed in")))
        speaker.finish()
        result(TurnResult.Unreachable)
        assertEquals(
            listOf(
                "That recording is too long.",
                "Choose a Transcription model first.",
                Phrases.REFUSED,
                Phrases.UNAUTHORIZED,
                Phrases.UNREACHABLE,
            ),
            speaker.spoken,
        )
    }

    @Test
    fun `the status command sends status and speaks the answer`() {
        c.requestStatus()
        val turn = backend.turns.single()
        assertTrue(turn.status)
        assertNull(turn.wav) // no audio with the status command
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
    fun `every request sends the chat of the last answer, the server applies its window`() {
        sayRequest()
        assertNull(backend.turns[0].conversationId)
        c.onEvent(DeviceEvent.VoiceSay("r1", "c1", "Moved.", false))
        speaker.finish()
        clock.now += 60 * 60 * 1000
        sayRequest()
        assertEquals("c1", backend.turns[1].conversationId)
        c.onEvent(DeviceEvent.VoiceSay("r2", null, "Failed.", false)) // no chat: keeps the last one
        speaker.finish()
        sayRequest()
        assertEquals("c1", backend.turns[2].conversationId)
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
            wake, FakeVad(), chimes, speaker, backend, history, clock, mono, timer, { it },
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
        backend.replies[0].onResult(ReplyResult.Unreachable)
        assertEquals("${Phrases.UNREACHABLE} ${Phrases.USE_NOTIFICATION}", speaker.spoken.last())
        speaker.finish()
        backend.replies[0].onResult(ReplyResult.Refused(ServerError(400, "transcription_failed", "The speech-to-text model didn't answer.")))
        assertEquals("The speech-to-text model didn't answer. ${Phrases.USE_NOTIFICATION}", speaker.spoken.last())
    }

    @Test
    fun `states are reported`() {
        sayRequest()
        assertEquals(listOf(ListenState.Listening, ListenState.Recording, ListenState.Listening), states)
    }

    // --- a run can't turn the phone into a listening device -----------------------------

    @Test
    fun `an approval with nothing to read is not listened for`() {
        val blank = Approval("q", "r1", Approval.Kind.Question, " ", "safe", question = "")
        c.onEvent(DeviceEvent.ApprovalRequested(blank))
        assertEquals(listOf(Phrases.NOTHING_TO_READ), speaker.spoken)
        speaker.finish()
        assertEquals(ListenState.Listening, c.state)
        val action = Approval("a", "r1", Approval.Kind.Action, "", "safe")
        c.onEvent(DeviceEvent.ApprovalRequested(action))
        speaker.finish()
        val plan = Approval("p", "r1", Approval.Kind.Plan, "", "safe", steps = listOf(" "))
        c.onEvent(DeviceEvent.ApprovalRequested(plan))
        speaker.finish()
        assertEquals(List(3) { Phrases.NOTHING_TO_READ }, speaker.spoken)
        assertFalse(chimes.played.contains("reply"))
    }

    @Test
    fun `a blank unclear prompt is not listened after`() {
        c.onEvent(DeviceEvent.ApprovalRequested(approval(Approval.Kind.Action)))
        speaker.finish()
        speakThenStop()
        backend.replies[0].onResult(ReplyResult.Unclear("hmm", " "))
        speaker.finish()
        assertEquals(ListenState.Listening, c.state)
    }

    @Test
    fun `the reply sound always plays before a reply recording`() {
        c.onEvent(DeviceEvent.ApprovalRequested(approval(Approval.Kind.Action)))
        speaker.finish()
        assertEquals(listOf("reply"), chimes.played)
        assertEquals(ListenState.Recording, c.state)
    }

    @Test
    fun `a reply lasts at most fifteen seconds once speech began`() {
        c.onEvent(DeviceEvent.ApprovalRequested(approval(Approval.Kind.Action)))
        speaker.finish()
        frames(Frames::silence, 50) // 4 s before the reply begins
        frames(Frames::speech, 187) // 14 960 ms of speech
        assertEquals(ListenState.Recording, c.state)
        c.onFrame(Frames.speech()) // 15 040 ms
        assertEquals(ListenState.Listening, c.state)
        val wav = backend.replies.single().wav
        assertEquals(44 + (50 + 188) * AudioFormat16k.FRAME_SAMPLES * 2, wav.size)
    }

    @Test
    fun `at most three reply windows per run in five minutes`() {
        repeat(3) { i ->
            c.onEvent(DeviceEvent.ApprovalRequested(approval(Approval.Kind.Question, id = "q$i")))
            speaker.finish()
            assertEquals(ListenState.Recording, c.state)
            speakThenStop()
        }
        c.onEvent(DeviceEvent.ApprovalRequested(approval(Approval.Kind.Question, id = "q3")))
        speaker.finish()
        assertEquals(Phrases.USE_NOTIFICATION, speaker.spoken.last())
        assertEquals(3, backend.replies.size)
        speaker.finish()
        assertEquals(ListenState.Listening, c.state)
        // another run still may; and after five minutes this one may again
        c.onEvent(DeviceEvent.ApprovalRequested(approval(Approval.Kind.Question, id = "x", run = "r2")))
        speaker.finish()
        assertEquals(ListenState.Recording, c.state)
        speakThenStop()
        mono.now += 5 * 60 * 1000
        c.onEvent(DeviceEvent.ApprovalRequested(approval(Approval.Kind.Question, id = "q4")))
        speaker.finish()
        assertEquals(ListenState.Recording, c.state)
    }

    @Test
    fun `at most six reply windows in all in five minutes`() {
        repeat(6) { i ->
            c.onEvent(DeviceEvent.ApprovalRequested(approval(Approval.Kind.Question, id = "q$i", run = "run$i")))
            speaker.finish()
            assertEquals(ListenState.Recording, c.state)
            speakThenStop()
        }
        c.onEvent(DeviceEvent.ApprovalRequested(approval(Approval.Kind.Question, id = "q6", run = "run6")))
        speaker.finish()
        assertEquals(Phrases.USE_NOTIFICATION, speaker.spoken.last())
        assertEquals(6, backend.replies.size)
    }

    @Test
    fun `an action without a risk needs a tap`() {
        c.onEvent(DeviceEvent.ApprovalRequested(approval(Approval.Kind.Action, risk = null)))
        assertEquals(listOf("Send an email to Tim. That one needs a tap."), speaker.spoken)
        speaker.finish()
        assertEquals(ListenState.Listening, c.state)
    }

    // --- nothing hangs -----------------------------------------------------------------

    @Test
    fun `speech that never reports back is given up`() {
        c.onEvent(DeviceEvent.VoiceSay("r1", "c1", "Done.", false))
        c.onEvent(DeviceEvent.VoiceSay("r2", "c2", "Next.", false))
        timer.advance(19_999 + 5 * 120)
        assertEquals(ListenState.Speaking, c.state)
        timer.advance(1)
        assertEquals(1, speaker.stops)
        assertEquals(listOf("Done.", "Next."), speaker.spoken) // moved on to the next
    }

    @Test
    fun `a recording that gets no frames is given up`() {
        c.onFrame(Frames.wake())
        assertEquals(ListenState.Recording, c.state)
        timer.advance(63_000)
        assertEquals(ListenState.Listening, c.state)
        assertTrue(backend.turns.isEmpty())
        assertEquals(listOf("start", "stop"), chimes.played)
    }

    @Test
    fun `a watchdog never fires after its state ended`() {
        c.onEvent(DeviceEvent.VoiceSay("r1", "c1", "Done.", false))
        speaker.finish()
        assertEquals(0, timer.pending)
        timer.advance(100_000)
        assertEquals(0, speaker.stops)
    }
}
