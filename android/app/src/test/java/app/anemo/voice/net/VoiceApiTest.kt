package app.anemo.voice.net

import app.anemo.voice.core.ReplyResult
import app.anemo.voice.core.TurnResult
import app.anemo.voice.core.Wav
import okhttp3.OkHttpClient
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

    @Test
    fun `a follow-up sends the conversation id`() {
        turn(conversationId = "c9")
        assertEquals("c9", fake.nextUpload().parts.getValue("conversation_id").text)
    }

    @Test
    fun `the status command sends status true and gets something to say`() {
        fake.turnResponse = FakeAnemo.json(200, """{"say":"Two runs are working."}""")
        assertEquals(TurnResult.Say("Two runs are working."), turn(status = true))
        assertEquals("true", fake.nextUpload().parts.getValue("status").text)
    }

    @Test
    fun `cancel words`() {
        fake.turnResponse = FakeAnemo.json(200, """{"cancelled":true}""")
        assertEquals(TurnResult.Cancelled, turn())
    }

    @Test
    fun `no transcription model`() {
        fake.turnResponse = FakeAnemo.json(409, """{"error":{"code":"no_transcription_model","message":"No model"}}""")
        assertEquals(TurnResult.NoTranscriptionModel, turn())
    }

    @Test
    fun `unsupported audio`() {
        fake.turnResponse = FakeAnemo.json(422, """{"error":{"code":"unsupported_audio","message":"Not audio"}}""")
        assertEquals(TurnResult.UnsupportedAudio, turn())
    }

    @Test
    fun `a wrong token is unauthorized`() {
        val wrong = VoiceApi(client, fake.address, "anemo_wrong")
        assertEquals(TurnResult.Unauthorized, turn(api = wrong))
    }

    @Test
    fun `a server error and no server are failures`() {
        fake.turnResponse = FakeAnemo.json(500, "oops")
        assertEquals(TurnResult.Failed(500), turn())
        fake.close()
        assertEquals(TurnResult.Failed(null), turn())
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
    fun `addresses`() {
        assertEquals("https://anemo.example.com/api/devices/ws", Address.parse("anemo.example.com")!!.deviceSocket.toString())
        assertEquals("https://x.org/anemo/api/voice/turns", Address.parse("https://x.org/anemo/")!!.api("voice/turns").toString())
        assertEquals("https://x.org/c/c1", Address.parse("https://x.org/?a=b#f")!!.chat("c1"))
        assertNull(Address.parse("http://x.org")) // never the token over plain http
        assertNull(Address.parse(""))
        assertNull(Address.parse("not an address"))
    }
}
