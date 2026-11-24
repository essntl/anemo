package app.anemo.voice.net

import app.anemo.voice.core.ReplyResult
import app.anemo.voice.core.ServerError
import app.anemo.voice.core.TranscriptResult
import app.anemo.voice.core.TurnResult
import app.anemo.voice.core.Wav
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

class VoiceApiTest {
    private val fake = FakeAnemo()
    private val client = OkHttpClient()
    private val api = VoiceApi(client, fake.address, fake.token)
    private val wav = Wav.encode(ShortArray(1_280) { (it % 100).toShort() })

    @After
    fun tearDown() = fake.close()

    private fun turn(conversationId: String? = null, status: Boolean = false, api: VoiceApi = this.api): TurnResult {
        val q = LinkedBlockingQueue<TurnResult>()
        api.sendTurn(wav, conversationId, status) { q.add(it) }
        return q.poll(5, TimeUnit.SECONDS)!!
    }

    private fun reply(approvalId: String = "a1"): ReplyResult {
        val q = LinkedBlockingQueue<ReplyResult>()
        api.sendReply(wav, approvalId) { q.add(it) }
        return q.poll(5, TimeUnit.SECONDS)!!
    }

    @Test
    fun `a turn uploads the wav with the bearer token and starts a run`() {
        val result = turn()
        assertEquals(TurnResult.Started("r1", "c1", "uh mail tom no tim", "Email Tim."), result)
        val up = fake.nextUpload()
        assertEquals("/api/voice/turns", up.path)
        assertEquals("Bearer ${fake.token}", up.headers["Authorization"])
        assertFalse("token in the URL", up.url.contains(fake.token))
        val audio = up.parts.getValue("audio")
        assertEquals("audio/wav", audio.contentType)
        assertTrue(audio.filename!!.endsWith(".wav"))
        assertTrue(audio.bytes.contentEquals(wav))
        assertFalse(up.parts.containsKey("conversation_id"))
        assertFalse(up.parts.containsKey("status"))
    }

    private fun transcript(): TranscriptResult {
        val q = LinkedBlockingQueue<TranscriptResult>()
        api.transcribe(wav) { q.add(it) }
        return q.poll(5, TimeUnit.SECONDS)!!
    }

    @Test
    fun `a transcript uploads only the wav and gives back what was heard`() {
        assertEquals(TranscriptResult.Heard("Uh mail Tom no Tim."), transcript())
        val up = fake.nextUpload()
        assertEquals("/api/voice/transcripts", up.path)
        assertEquals("Bearer ${fake.token}", up.headers["Authorization"])
        assertEquals(setOf("audio"), up.parts.keys)
        assertTrue(up.parts.getValue("audio").bytes.contentEquals(wav))
    }

    @Test
    fun `a transcript of nothing, and its errors`() {
        fake.transcriptResponse = FakeAnemo.json(200, """{"heard":"","say":"Sorry, I didn't catch that."}""")
        assertEquals(TranscriptResult.Say("Sorry, I didn't catch that."), transcript())
        fake.transcriptResponse = FakeAnemo.error(409, "no_transcription_model", "Choose one.")
        assertEquals(TranscriptResult.Refused(ServerError(409, "no_transcription_model", "Choose one.")), transcript())
        fake.transcriptResponse = FakeAnemo.json(404, """{"detail":"Not Found"}""") // an older Anemo
        assertEquals(404, (transcript() as TranscriptResult.Refused).error.httpStatus)
        val wrong = VoiceApi(client, fake.address, "anemo_wrong")
        val q = LinkedBlockingQueue<TranscriptResult>()
        wrong.transcribe(wav) { q.add(it) }
        assertTrue(q.poll(5, TimeUnit.SECONDS) is TranscriptResult.Unauthorized)
    }

    @Test
    fun `a request as text sends the text, voice mode and keep chat, and no audio`() {
        val q = LinkedBlockingQueue<TurnResult>()
        api.sendText("What's on today?", "c1", voiceMode = true, keepChat = true) { q.add(it) }
        assertEquals(TurnResult.Started("r1", "c1", "uh mail tom no tim", "Email Tim."), q.poll(5, TimeUnit.SECONDS))
        val up = fake.nextUpload()
        assertEquals("/api/voice/turns", up.path)
        assertEquals("What's on today?", up.parts.getValue("text").text)
        assertEquals("c1", up.parts.getValue("conversation_id").text)
        assertEquals("true", up.parts.getValue("voice_mode").text)
        assertEquals("true", up.parts.getValue("keep_chat").text)
        assertFalse(up.parts.containsKey("audio"))
        // outside voice mode neither field is sent
        api.sendText("x".repeat(5_000), null, voiceMode = false, keepChat = false) { q.add(it) }
        q.poll(5, TimeUnit.SECONDS)
        val plain = fake.nextUpload()
        assertEquals(setOf("text"), plain.parts.keys)
        assertEquals(VoiceApi.MAX_TEXT_CHARS, plain.parts.getValue("text").text.length)
    }

    @Test
    fun `a follow-up sends the conversation id`() {
        turn(conversationId = "c9")
        assertEquals("c9", fake.nextUpload().parts.getValue("conversation_id").text)
    }

    @Test
    fun `the status command sends status true and no audio`() {
        fake.statusSay = "Two runs are working."
        val q = LinkedBlockingQueue<TurnResult>()
        api.sendTurn(null, null, status = true) { q.add(it) }
        assertEquals(TurnResult.Say("Two runs are working."), q.poll(5, TimeUnit.SECONDS))
        val up = fake.nextUpload()
        assertEquals("true", up.parts.getValue("status").text)
        assertFalse(up.parts.containsKey("audio"))
    }

    @Test
    fun `cancel words`() {
        fake.turnResponse = FakeAnemo.json(200, """{"cancelled":true}""")
        assertEquals(TurnResult.Cancelled, turn())
    }

    @Test
    fun `nothing heard comes back as something to say`() {
        fake.turnResponse = FakeAnemo.json(200, """{"say":"Sorry, I didn't catch that."}""")
        assertEquals(TurnResult.Say("Sorry, I didn't catch that."), turn())
    }

    @Test
    fun `no transcription model carries the server's message`() {
        fake.turnResponse = FakeAnemo.error(409, "no_transcription_model", "Choose a Transcription model in Settings.")
        assertEquals(
            TurnResult.Refused(ServerError(409, "no_transcription_model", "Choose a Transcription model in Settings.")),
            turn(),
        )
    }

    @Test
    fun `the three 422 codes carry their message`() {
        for (code in listOf("empty_audio", "audio_too_large", "unsupported_audio")) {
            fake.turnResponse = FakeAnemo.error(422, code, "Message for $code")
            assertEquals(TurnResult.Refused(ServerError(422, code, "Message for $code")), turn())
        }
    }

    @Test
    fun `any other error carries its message`() {
        fake.turnResponse = FakeAnemo.error(400, "transcription_failed", "The speech-to-text model didn't answer.")
        assertEquals(
            TurnResult.Refused(ServerError(400, "transcription_failed", "The speech-to-text model didn't answer.")),
            turn(),
        )
    }

    @Test
    fun `a proxy's error page has no message`() {
        fake.turnResponse = MockResponse().setResponseCode(413).setBody("<html><body>413 Request Entity Too Large</body></html>")
        assertEquals(TurnResult.Refused(ServerError(413, null, null)), turn())
    }

    @Test
    fun `a wrong token is unauthorized`() {
        val wrong = VoiceApi(client, fake.address, "anemo_wrong")
        assertEquals(TurnResult.Unauthorized(ServerError(401, "unauthorized", "Bad token")), turn(api = wrong))
    }

    @Test
    fun `no server is unreachable`() {
        fake.close()
        assertEquals(TurnResult.Unreachable, turn())
    }

    @Test
    fun `JSON nulls are absent, not the text null`() {
        fake.turnResponse = FakeAnemo.json(202, """{"run_id":"r1","conversation_id":null,"heard":null,"request":"Hi."}""")
        assertEquals(TurnResult.Started("r1", null, "", "Hi."), turn())
    }

    @Test
    fun `a reply sends the approval id and is decided`() {
        assertEquals(ReplyResult.Decided("approve", "yes"), reply("a7"))
        val up = fake.nextUpload()
        assertEquals("/api/voice/replies", up.path)
        assertEquals("Bearer ${fake.token}", up.headers["Authorization"])
        assertEquals("a7", up.parts.getValue("approval_id").text)
        assertTrue(up.parts.getValue("audio").bytes.contentEquals(wav))
    }

    @Test
    fun `a reply that is a no`() {
        fake.replyResponse = FakeAnemo.json(200, """{"decided":"deny","heard":"no"}""")
        assertEquals(ReplyResult.Decided("deny", "no"), reply())
    }

    @Test
    fun `an unclear reply carries what to say`() {
        fake.replyResponse = FakeAnemo.json(200, """{"decided":null,"heard":"hmm","say":"Sorry, was that a yes?"}""")
        assertEquals(ReplyResult.Unclear("hmm", "Sorry, was that a yes?"), reply())
    }

    @Test
    fun `needs a tap and already decided`() {
        fake.replyResponse = FakeAnemo.json(409, """{"error":{"code":"needs_tap"}}""")
        assertEquals(ReplyResult.NeedsTap, reply())
        fake.replyResponse = FakeAnemo.json(409, """{"error":{"code":"already_decided"}}""")
        assertEquals(ReplyResult.AlreadyDecided, reply())
    }

    @Test
    fun `reply errors carry the server's message`() {
        fake.replyResponse = FakeAnemo.error(422, "audio_too_large", "Too long.")
        assertEquals(ReplyResult.Refused(ServerError(422, "audio_too_large", "Too long.")), reply())
        fake.replyResponse = FakeAnemo.error(409, "no_transcription_model", "No model.")
        assertEquals(ReplyResult.Refused(ServerError(409, "no_transcription_model", "No model.")), reply())
        fake.close()
        assertEquals(ReplyResult.Unreachable, reply())
    }

    @Test
    fun `addresses`() {
        assertEquals("https://anemo.example.com/api/devices/ws", Address.parse("anemo.example.com")!!.deviceSocket.toString())
        assertEquals("https://x.org/anemo/api/voice/turns", Address.parse("https://x.org/anemo/")!!.api("voice/turns").toString())
        assertEquals("https://x.org/c/c1", Address.parse("https://x.org/?a=b#f")!!.chat("c1"))
        assertNull(Address.parse("http://x.org")) // never the token over plain http
        assertNull(Address.parse(""))
        assertNull(Address.parse("not an address"))
    }
}
