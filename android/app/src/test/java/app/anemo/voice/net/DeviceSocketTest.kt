package app.anemo.voice.net

import app.anemo.voice.core.Approval
import app.anemo.voice.core.DeviceEvent
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.random.Random

class DeviceSocketTest {
    private val fake = FakeAnemo()
    private val client = OkHttpClient()
    private val executor = Executors.newSingleThreadScheduledExecutor()
    private val seen = LinkedBlockingQueue<Any>()
    private var socket: DeviceSocket? = null

    private data class Connected(val name: String, val missed: Boolean)
    private data class Disconnected(val retryInMs: Long)
    private data class Stopped(val reason: DeviceSocket.StopReason)
    private data class Notice(val text: String)

    private val listener = object : DeviceSocket.Listener {
        override fun onConnected(deviceName: String, missed: Boolean) {
            seen.add(Connected(deviceName, missed))
        }
        override fun onEvent(event: DeviceEvent) {
            seen.add(event)
        }
        override fun onNotice(text: String) {
            seen.add(Notice(text))
        }
        override fun onDisconnected(retryInMs: Long) {
            seen.add(Disconnected(retryInMs))
        }
        override fun onStopped(reason: DeviceSocket.StopReason) {
            seen.add(Stopped(reason))
        }
    }

    private fun open(
        token: String = fake.token,
        pingMs: Long = 20_000,
        silenceMs: Long = 50_000,
        client: OkHttpClient = this.client,
    ): DeviceSocket {
        val s = DeviceSocket(
            client, fake.address.deviceSocket, token, "1.0.0", listener, executor,
            backoff = Backoff(initialMs = 20, maxMs = 200, random = Random(1)),
            pingIntervalMs = pingMs, silenceTimeoutMs = silenceMs,
        )
        socket = s
        s.start()
        return s
    }

    private fun next(): Any = checkNotNull(seen.poll(5, TimeUnit.SECONDS)) { "nothing happened" }

    private fun nextOf(type: String): JSONObject {
        while (true) {
            val m = checkNotNull(fake.received.poll(5, TimeUnit.SECONDS)) { "no $type" }
            if (m.optString("type") == type) return m
        }
    }

    @After
    fun tearDown() {
        socket?.stop()
        executor.shutdown()
        executor.awaitTermination(2, TimeUnit.SECONDS)
        fake.close()
    }

    @Test
    fun `hello carries the token, kind phone, version and no last id`() {
        open()
        val hello = nextOf("hello")
        assertEquals(fake.token, hello.getString("token"))
        assertEquals("phone", hello.getString("kind"))
        assertEquals("1.0.0", hello.getString("version"))
        assertTrue(hello.isNull("last_id"))
        assertEquals(Connected("Pixel", false), next())
        val request = fake.wsRequests.poll(5, TimeUnit.SECONDS)!!
        assertFalse("token in the URL", request.requestUrl.toString().contains(fake.token))
        assertNull("an Origin header", request.getHeader("Origin"))
        assertNull(request.getHeader("Authorization"))
    }

    @Test
    fun `pings every interval and takes the pong`() {
        open(pingMs = 100)
        assertEquals(Connected("Pixel", false), next())
        nextOf("ping")
        nextOf("ping")
        assertTrue(seen.isEmpty()) // pongs keep it alive: no reconnect
        assertEquals(1, fake.connectionCount.get())
    }

    @Test
    fun `every event a phone gets, and the ones it ignores`() {
        open()
        next()
        val conn = fake.nextConnection()
        conn.event("e1", "run.status", JSONObject().put("run_id", "r1").put("status", "running"))
        conn.event(
            "e2", "approval.requested",
            JSONObject().put("approval_id", "a1").put("run_id", "r1").put("kind", "action")
                .put("summary", "Send an email").put("risk", "dangerous"),
        )
        conn.event(
            "e3", "approval.requested",
            JSONObject().put("approval_id", "a2").put("run_id", "r1").put("kind", "question")
                .put("summary", "Asks").put("risk", "safe").put("question", "Which day?")
                .put("options", JSONArray(listOf("Monday", "Friday"))),
        )
        conn.event(
            "e4", "approval.requested",
            JSONObject().put("approval_id", "a3").put("run_id", "r1").put("kind", "plan")
                .put("summary", "Plan").put("risk", "safe").put("steps", JSONArray(listOf("One", "Two"))),
        )
        conn.event("e5", "approval.requested", JSONObject().put("approval_id", "a4").put("kind", "hologram"))
        conn.event("e6", "something.new", JSONObject().put("x", 1))
        conn.event("e7", "approval.decided", JSONObject().put("approval_id", "a1").put("decision", "deny"))
        conn.event(
            "e8", "voice.say",
            JSONObject().put("run_id", "r1").put("conversation_id", "c1").put("text", "Done.").put("more", true),
        )
        conn.event("e9", "voice.stop", JSONObject().put("run_id", "r1").put("conversation_id", "c1"))
        assertEquals(DeviceEvent.RunStatus("r1", "running"), next())
        assertEquals(
            DeviceEvent.ApprovalRequested(Approval("a1", "r1", Approval.Kind.Action, "Send an email", "dangerous")),
            next(),
        )
        assertEquals(
            DeviceEvent.ApprovalRequested(
                Approval("a2", "r1", Approval.Kind.Question, "Asks", "safe", "Which day?", listOf("Monday", "Friday")),
            ),
            next(),
        )
        assertEquals(
            DeviceEvent.ApprovalRequested(Approval("a3", "r1", Approval.Kind.Plan, "Plan", "safe", steps = listOf("One", "Two"))),
            next(),
        )
        assertEquals(DeviceEvent.ApprovalDecided("a1", "deny"), next())
        assertEquals(DeviceEvent.VoiceSay("r1", "c1", "Done.", true), next())
        assertEquals(DeviceEvent.VoiceStop("r1", "c1"), next())
        assertEquals("e9", socket!!.lastId)
    }

    @Test
    fun `a dropped connection comes back and resumes from the last event`() {
        open()
        next()
        val conn = fake.nextConnection()
        assertEquals("cur-0", socket!!.lastId)
        conn.event("e41", "run.status", JSONObject().put("run_id", "r1").put("status", "running"))
        next()
        fake.cursor = "e41"
        conn.socket.close(1001, "going away")
        assertTrue(next() is Disconnected)
        assertEquals(Connected("Pixel", false), next())
        val hellos = fake.received.filter { it.optString("type") == "hello" }
        assertEquals(2, hellos.size)
        assertEquals("e41", hellos[1].getString("last_id"))
    }

    @Test
    fun `without events it resumes from the welcome's cursor and reports missed`() {
        fake.cursor = "cur-7"
        open()
        next()
        fake.missed = true
        fake.nextConnection().socket.close(1011, "server restarts")
        assertTrue(next() is Disconnected)
        assertEquals(Connected("Pixel", true), next())
        val hellos = fake.received.filter { it.optString("type") == "hello" }
        assertEquals("cur-7", hellos[1].getString("last_id"))
    }

    @Test
    fun `back-off grows while the server is away`() {
        val port = fake.server.port
        fake.close()
        val s = DeviceSocket(
            client, okhttp3.HttpUrl.Builder().scheme("http").host("127.0.0.1").port(port).addPathSegments("api/devices/ws").build(),
            "t", "1.0.0", listener, executor, Backoff(initialMs = 10, maxMs = 40, random = Random(1)),
        )
        socket = s
        s.start()
        val delays = (1..4).map { (next() as Disconnected).retryInMs }
        assertTrue(delays.toString(), delays[1] > delays[0] && delays[2] > delays[1])
        assertTrue(delays.toString(), delays[3] <= 48)
    }

    @Test
    fun `a quiet connection is dropped and made again`() {
        fake.answerPings = false
        open(pingMs = 50, silenceMs = 200)
        next()
        assertTrue(next() is Disconnected)
        assertTrue(next() is Connected)
    }

    @Test
    fun `a revoked token stops for good`() = stopsWith(DeviceSocket.StopReason.BadToken) { open(token = "anemo_revoked") }

    @Test
    fun `a bad hello stops for good`() = stopsWith(DeviceSocket.StopReason.BadHello) {
        fake.closeHelloWith = 4400
        open()
    }

    @Test
    fun `replaced by a newer connection stops for good`() = stopsWith(DeviceSocket.StopReason.Replaced) {
        fake.closeHelloWith = 4409
        open()
    }

    @Test
    fun `an Origin header is refused`() = stopsWith(DeviceSocket.StopReason.OriginRefused) {
        val withOrigin = client.newBuilder().addInterceptor { chain ->
            val r: Request = chain.request().newBuilder().header("Origin", "https://evil.example").build()
            chain.proceed(r)
        }.build()
        open(client = withOrigin)
    }

    private fun stopsWith(reason: DeviceSocket.StopReason, start: () -> Unit) {
        start()
        assertEquals(Stopped(reason), next())
        Thread.sleep(300) // back-off is 20 ms: a reconnect would have happened
        assertEquals(1, fake.connectionCount.get())
        assertTrue(seen.isEmpty())
    }

    @Test
    fun `voice mode messages go to the server, and wait while it is away`() {
        val s = open()
        next()
        s.send(Protocol.voiceMode(true, "tile"))
        val on = nextOf("voice.mode")
        assertTrue(on.getBoolean("on"))
        assertEquals("tile", on.getString("cause"))
        assertEquals(setOf("type", "on", "cause"), on.keys().asSequence().toSet())
        // the connection drops: what is sent meanwhile goes after the next welcome
        fake.nextConnection().socket.close(1001, "going away")
        assertTrue(next() is Disconnected)
        s.send(Protocol.voiceMode(false, "timeout"))
        assertEquals(Connected("Pixel", false), next())
        val off = nextOf("voice.mode")
        assertFalse(off.getBoolean("on"))
        assertEquals("timeout", off.getString("cause"))
    }

    @Test
    fun `a notice is passed on`() {
        fake.notice = "Update Anemo Voice: this version is too old."
        open()
        next()
        assertEquals(Notice("Update Anemo Voice: this version is too old."), next())
    }

    @Test
    fun `stop closes and does not come back`() {
        val s = open()
        next()
        s.stop()
        Thread.sleep(300)
        assertEquals(1, fake.connectionCount.get())
        assertTrue(seen.isEmpty())
    }

    @Test
    fun `a trust change (1012) reconnects`() {
        open()
        next()
        fake.nextConnection().socket.close(1012, "trust changed")
        assertTrue(next() is Disconnected)
        assertEquals(Connected("Pixel", false), next())
        assertEquals(2, fake.connectionCount.get())
    }

    @Test
    fun `replaced in the middle of a connection stops for good`() {
        open()
        next()
        fake.nextConnection().socket.close(4409, "replaced")
        assertEquals(Stopped(DeviceSocket.StopReason.Replaced), next())
        Thread.sleep(300)
        assertEquals(1, fake.connectionCount.get())
    }

    @Test
    fun `a revoked token in the middle of a connection stops for good`() {
        open()
        next()
        fake.nextConnection().socket.close(4401, "revoked")
        assertEquals(Stopped(DeviceSocket.StopReason.BadToken), next())
    }

    @Test
    fun `a hello longer than the server reads is refused`() =
        stopsWith(DeviceSocket.StopReason.BadHello) { open(token = "anemo_" + "x".repeat(FakeAnemo.MAX_HELLO)) }

    @Test
    fun `an action without a risk arrives without one, and JSON nulls are absent`() {
        open()
        next()
        val conn = fake.nextConnection()
        conn.event("e1", "approval.requested", JSONObject().put("approval_id", "a1").put("run_id", "r1").put("kind", "action").put("summary", "Delete"))
        val a = (next() as DeviceEvent.ApprovalRequested).approval
        assertNull(a.risk)
        assertTrue(a.dangerous)
        conn.event("e2", "voice.say", JSONObject().put("run_id", "r1").put("conversation_id", JSONObject.NULL).put("text", "Failed."))
        assertEquals(DeviceEvent.VoiceSay("r1", null, "Failed.", false), next())
    }
}
