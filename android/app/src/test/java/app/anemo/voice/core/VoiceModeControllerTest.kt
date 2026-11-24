package app.anemo.voice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** The cue on detection (B1) and voice mode (B2) in the voice loop (docs/specs/07-voice-mode-android.md). */
class VoiceModeControllerTest {
    private val wake = FakeWake()
    private val chimes = FakeChimes()
    private val speaker = FakeSpeaker()
    private val backend = FakeBackend()
    private val history = MemoryHistory()
    private val timer = FakeTimer()
    private val focus = FakeFocus()
    private val changes = mutableListOf<Pair<Boolean, VoiceModeCause>>()
    private val scores = mutableListOf<Float>()
    private lateinit var c: VoiceController

    @Before
    fun setUp() {
        c = make(VoiceController.Options(voiceModeIdleMs = 45_000))
        c.start()
    }

    private fun make(options: VoiceController.Options) = VoiceController(
        wake, FakeVad(), chimes, speaker, backend, history, FakeClock(), FakeClock(0), timer,
        chatLink = { "https://anemo.test/c/$it" },
        listener = object : VoiceController.Listener {
            override fun onVoiceModeChanged(on: Boolean, cause: VoiceModeCause) {
                changes += on to cause
            }
            override fun onWakeWord(score: Float) {
                scores += score
            }
        },
        focus = focus,
        options = options,
    )

    private fun frames(make: () -> ShortArray, count: Int) = repeat(count) { c.onFrame(make()) }

    private fun speakThenStop() {
        frames(Frames::speech, 6)
        frames(Frames::silence, 13)
    }

    private fun sayRequest(heard: String) {
        backend.heard = heard
        c.onFrame(Frames.wake())
        speakThenStop()
    }

    /** Voice mode opened the microphone: skip the echo frames, then speak. */
    private fun speakInVoiceMode(heard: String) {
        assertEquals(ListenState.Recording, c.state)
        backend.heard = heard
        speakThenStop()
    }

    private fun answer(run: String, text: String = "Done.") {
        c.onEvent(DeviceEvent.VoiceSay(run, "c1", text, false))
        speaker.finish()
    }

    private fun turnOnByTile() {
        c.setVoiceMode(true, VoiceModeCause.Tile)
        chimes.played.clear()
    }

    // --- B1: the cue on detection ------------------------------------------------------

    @Test
    fun `on detection the music ducks and the cue plays before the next frame, and the score is logged`() {
        assertFalse(focus.held)
        c.onFrame(Frames.wake())
        assertTrue(focus.held)
        assertEquals(listOf("start"), chimes.played)
        assertEquals(listOf(0.83f), scores)
        speakThenStop()
        assertFalse(focus.held) // given back when the recording ends
        assertEquals(listOf("start", "end"), chimes.played)
    }

    @Test
    fun `the request said in one breath keeps the frame before the wake word fired`() {
        val before = ShortArray(AudioFormat16k.FRAME_SAMPLES) { 3 }
        c.onFrame(Frames.silence())
        c.onFrame(before)
        c.onFrame(Frames.wake())
        speakThenStop()
        val samples = backend.transcripts.single().wav.size / 2 - 22
        // the frame before, the wake frame, 6 speech, 13 silence (not the older silence)
        assertEquals(21 * AudioFormat16k.FRAME_SAMPLES, samples)
        assertEquals(3, backend.transcripts.single().wav[44].toInt()) // starts with the frame before
    }

    @Test
    fun `the wake word itself is not counted as speech`() {
        // Pre-roll frames are not given to the end-of-speech detector: wake word then silence times out.
        c.onFrame(Frames.speech())
        c.onFrame(Frames.wake())
        frames(Frames::silence, 63)
        assertTrue(backend.transcripts.isEmpty())
        assertEquals(listOf("start", "timeout"), chimes.played)
        assertFalse(focus.held)
    }

    @Test
    fun `the wake word is removed from the request sent on`() {
        sayRequest("Hey Jarvis, what's on tomorrow?")
        assertEquals("what's on tomorrow?", backend.turns.single().text)
    }

    @Test
    fun `only the wake word heard, nothing is sent, the phone says so`() {
        sayRequest("Hey Jarvis.")
        assertTrue(backend.turns.isEmpty())
        assertEquals(listOf(Phrases.NOT_HEARD), speaker.spoken)
    }

    @Test
    fun `an older Anemo without the transcript endpoint gets the recording`() {
        backend.heard = null
        c.onFrame(Frames.wake())
        speakThenStop()
        val t = backend.transcripts.single()
        t.onResult(TranscriptResult.Refused(ServerError(404, null, null)))
        val turn = backend.turns.single()
        assertTrue(t.wav.contentEquals(turn.wav!!))
        assertNull(turn.text)
    }

    @Test
    fun `a transcript the server refuses is said`() {
        backend.heard = null
        c.onFrame(Frames.wake())
        speakThenStop()
        backend.transcripts.single().onResult(TranscriptResult.Refused(ServerError(409, "no_transcription_model", "Choose one.")))
        assertEquals(listOf("Choose one."), speaker.spoken)
        assertTrue(backend.turns.isEmpty())
    }

    // --- B2: turning voice mode on -----------------------------------------------------

    @Test
    fun `the tile turns it on, the on sound, then the microphone opens without a wake word`() {
        c.setVoiceMode(true, VoiceModeCause.Tile)
        assertEquals(listOf(true to VoiceModeCause.Tile), changes)
        assertEquals(listOf("voicemodeon"), chimes.played) // no start sound on top of it
        assertEquals(ListenState.Recording, c.state)
        assertTrue(focus.held)
    }

    @Test
    fun `start voice mode said after the wake word turns it on, nothing is sent`() {
        sayRequest("Hey Jarvis, start voice mode.")
        assertTrue(backend.turns.isEmpty())
        assertEquals(listOf(true to VoiceModeCause.Phrase), changes)
        assertEquals(listOf("start", "end", "voicemodeon"), chimes.played)
        assertEquals(ListenState.Recording, c.state)
    }

    @Test
    fun `the phrase can be switched off, then it is an ordinary request`() {
        c = make(VoiceController.Options(startPhrase = false))
        c.start()
        sayRequest("Start voice mode.")
        assertEquals("Start voice mode.", backend.turns.single().text)
        assertTrue(changes.isEmpty())
    }

    @Test
    fun `stop said outside voice mode is an ordinary request`() {
        sayRequest("Stop.")
        assertEquals("Stop.", backend.turns.single().text)
        assertTrue(changes.isEmpty())
    }

    @Test
    fun `nothing from the server turns it on or opens the microphone`() {
        // Answers that say the command, voice.stop, run status: none of them is matched.
        c.onEvent(DeviceEvent.VoiceSay("r1", "c1", "Hey Jarvis, start voice mode.", false))
        speaker.finish()
        c.onEvent(DeviceEvent.VoiceStop("r1", "c1"))
        c.onEvent(DeviceEvent.RunStatus("r1", "completed"))
        assertFalse(c.voiceModeOn)
        assertEquals(ListenState.Listening, c.state)
        // a turn result whose text is the phrase doesn't either
        sayRequest("what should I say")
        backend.turns.single().onResult(TurnResult.Say("Start voice mode."))
        speaker.finish()
        assertFalse(c.voiceModeOn)
        assertEquals(ListenState.Listening, c.state)
        assertTrue(changes.isEmpty())
    }

    // --- B2: the conversation ----------------------------------------------------------

    @Test
    fun `after each answer the start sound plays and the microphone opens again, in the same chat`() {
        turnOnByTile()
        speakInVoiceMode("What's on today?")
        val first = backend.turns.single()
        assertEquals("What's on today?", first.text)
        assertTrue(first.voiceMode)
        assertFalse(first.keepChat) // the first request of the session uses the follow-up window
        first.onResult(TurnResult.Started("r1", "c1", "What's on today?", "What's on today?"))
        assertEquals(ListenState.Listening, c.state) // waiting for the answer
        answer("r1", "Two meetings.")
        assertEquals(listOf("end", "reopen"), chimes.played)
        assertEquals(ListenState.Recording, c.state)
        speakInVoiceMode("And tomorrow?")
        val second = backend.turns[1]
        assertTrue(second.voiceMode)
        assertTrue(second.keepChat)
        assertEquals("c1", second.conversationId)
    }

    @Test
    fun `the first frames after a reopen are not recorded`() {
        turnOnByTile()
        speakInVoiceMode("Hello")
        // 3 skipped, then 6 speech + 13 silence minus the 3 skipped = 16 frames
        assertEquals(16 * AudioFormat16k.FRAME_SAMPLES * 2 + 44, backend.transcripts.single().wav.size)
    }

    @Test
    fun `answers of other runs are only spoken`() {
        turnOnByTile()
        speakInVoiceMode("What's on today?")
        backend.turns[0].onResult(TurnResult.Started("r1", "c1", "", ""))
        answer("other", "Your export is done.")
        assertEquals(ListenState.Listening, c.state)
        answer("r1")
        assertEquals(ListenState.Recording, c.state)
    }

    @Test
    fun `the phone's own answer also reopens, nothing heard, an error, cancel`() {
        turnOnByTile()
        speakInVoiceMode("Hey Jarvis.") // only the wake word
        assertEquals(listOf(Phrases.NOT_HEARD), speaker.spoken)
        speaker.finish()
        assertEquals(ListenState.Recording, c.state)
        speakInVoiceMode("Add milk.")
        backend.turns[0].onResult(TurnResult.Unreachable)
        speaker.finish()
        assertEquals(ListenState.Recording, c.state)
        speakInVoiceMode("Never mind.")
        backend.turns[1].onResult(TurnResult.Cancelled)
        assertEquals(ListenState.Recording, c.state)
    }

    @Test
    fun `a reopen waits until approvals were asked and answered`() {
        turnOnByTile()
        speakInVoiceMode("Email Tim.")
        backend.turns[0].onResult(TurnResult.Started("r1", "c1", "", ""))
        c.onEvent(DeviceEvent.ApprovalRequested(Approval("a1", "r1", Approval.Kind.Action, "Send the email", "safe")))
        speaker.finish()
        assertEquals(listOf("end", "reply"), chimes.played) // the reply window, not voice mode
        speakThenStop()
        assertEquals(1, backend.replies.size)
        answer("r1", "Sent.")
        assertEquals("reopen", chimes.played.last())
    }

    @Test
    fun `start voice mode said while on just listens again`() {
        turnOnByTile()
        speakInVoiceMode("Start voice mode")
        assertEquals(ListenState.Recording, c.state)
        assertEquals(listOf(true to VoiceModeCause.Tile), changes)
        assertTrue(backend.turns.isEmpty())
    }

    @Test
    fun `the wake word still works in voice mode, and its request counts as one`() {
        turnOnByTile()
        speakInVoiceMode("Add milk.")
        backend.turns[0].onResult(TurnResult.Started("r1", "c1", "", ""))
        sayRequest("Hey Jarvis, add eggs too.")
        val second = backend.turns[1]
        assertTrue(second.voiceMode)
        second.onResult(TurnResult.Started("r2", "c1", "", ""))
        answer("r1") // the older run: only spoken
        assertEquals(ListenState.Listening, c.state)
        answer("r2")
        assertEquals(ListenState.Recording, c.state)
    }

    // --- B2: every way out -------------------------------------------------------------

    @Test
    fun `stop said in voice mode ends it`() {
        turnOnByTile()
        speakInVoiceMode("Stop.")
        assertEquals(false to VoiceModeCause.StopPhrase, changes.last())
        assertEquals(listOf("end", "voicemodeoff"), chimes.played)
        assertEquals(ListenState.Listening, c.state)
        assertTrue(backend.turns.isEmpty())
    }

    @Test
    fun `end voice mode after the wake word ends it`() {
        turnOnByTile()
        speakInVoiceMode("Add milk.")
        backend.turns[0].onResult(TurnResult.Started("r1", "c1", "", ""))
        sayRequest("Hey Jarvis, end voice mode.")
        assertEquals(false to VoiceModeCause.StopPhrase, changes.last())
        answer("r1") // its answer is spoken, the microphone stays closed
        assertEquals(ListenState.Listening, c.state)
    }

    @Test
    fun `nobody speaking for the idle time ends it`() {
        turnOnByTile()
        frames(Frames::silence, 3 + 45_000 / 80) // the skipped frames, then 44 960 ms
        assertEquals(ListenState.Recording, c.state)
        c.onFrame(Frames.silence())
        assertEquals(listOf(false to VoiceModeCause.Timeout), changes.drop(1))
        assertEquals(listOf("voicemodeoff"), chimes.played) // not the timeout sound on top
        assertEquals(ListenState.Listening, c.state)
        assertFalse(focus.held)
        assertTrue(backend.transcripts.isEmpty())
    }

    @Test
    fun `the idle time is a setting`() {
        c = make(VoiceController.Options(voiceModeIdleMs = 30_000))
        c.start()
        c.setVoiceMode(true, VoiceModeCause.Tile)
        frames(Frames::silence, 3 + 30_000 / 80)
        assertFalse(c.voiceModeOn)
    }

    @Test
    fun `voice stop ends it once the answer of that run was spoken`() {
        turnOnByTile()
        speakInVoiceMode("Thanks, that's all.")
        backend.turns[0].onResult(TurnResult.Started("r1", "c1", "", ""))
        c.onEvent(DeviceEvent.VoiceStop("r1", "c1"))
        assertTrue(c.voiceModeOn) // not yet: the goodbye is still to be said
        c.onEvent(DeviceEvent.VoiceSay("r1", "c1", "Goodbye!", false))
        assertTrue(c.voiceModeOn)
        speaker.finish()
        assertFalse(c.voiceModeOn)
        assertEquals(false to VoiceModeCause.VoiceStop, changes.last())
        assertEquals("voicemodeoff", chimes.played.last())
        assertEquals(ListenState.Listening, c.state)
    }

    @Test
    fun `voice stop of another run or an older session does nothing`() {
        turnOnByTile()
        speakInVoiceMode("Add milk.")
        backend.turns[0].onResult(TurnResult.Started("r1", "c1", "", ""))
        c.onEvent(DeviceEvent.VoiceStop("other", null))
        answer("r1")
        assertTrue(c.voiceModeOn)
        assertEquals(ListenState.Recording, c.state)
    }

    @Test
    fun `the tile or the notification ends it, and what voice mode was recording is thrown away`() {
        turnOnByTile()
        frames(Frames::speech, 3)
        c.setVoiceMode(false, VoiceModeCause.Notification)
        assertEquals(false to VoiceModeCause.Notification, changes.last())
        assertEquals(ListenState.Listening, c.state)
        frames(Frames::silence, 20)
        assertTrue(backend.transcripts.isEmpty())
        assertFalse(focus.held)
    }

    @Test
    fun `leaving while an answer is spoken lets it finish and does not reopen`() {
        turnOnByTile()
        speakInVoiceMode("Add milk.")
        backend.turns[0].onResult(TurnResult.Started("r1", "c1", "", ""))
        c.onEvent(DeviceEvent.VoiceSay("r1", "c1", "Added.", false))
        c.setVoiceMode(false, VoiceModeCause.Tile)
        assertEquals(ListenState.Speaking, c.state)
        speaker.finish()
        assertEquals(ListenState.Listening, c.state)
    }

    @Test
    fun `a request recorded when voice mode went on is sent in voice mode`() {
        c.onFrame(Frames.wake())
        c.setVoiceMode(true, VoiceModeCause.Tile)
        assertEquals(ListenState.Recording, c.state) // the same recording goes on
        backend.heard = "Add milk."
        speakThenStop()
        val turn = backend.turns.single()
        assertTrue(turn.voiceMode)
        turn.onResult(TurnResult.Started("r1", "c1", "", ""))
        answer("r1")
        assertEquals(ListenState.Recording, c.state)
    }

    @Test
    fun `an answer of an older session never reopens`() {
        turnOnByTile()
        speakInVoiceMode("Add milk.")
        val first = backend.turns[0]
        c.setVoiceMode(false, VoiceModeCause.Tile)
        c.setVoiceMode(true, VoiceModeCause.Tile)
        c.setVoiceMode(false, VoiceModeCause.Tile) // and off again: waiting for the wake word
        first.onResult(TurnResult.Started("r1", "c1", "", ""))
        answer("r1")
        assertEquals(ListenState.Listening, c.state)
    }

    @Test
    fun `pause and stop end it`() {
        turnOnByTile()
        c.pause()
        assertEquals(false to VoiceModeCause.ServiceStopped, changes.last())
        c.resume()
        assertFalse(c.voiceModeOn)
        c.setVoiceMode(true, VoiceModeCause.Tile)
        c.stop()
        assertEquals(false to VoiceModeCause.ServiceStopped, changes.last())
    }

    @Test
    fun `not while paused or stopped`() {
        c.pause()
        c.setVoiceMode(true, VoiceModeCause.Tile)
        assertFalse(c.voiceModeOn)
        assertTrue(changes.isEmpty())
    }
}
