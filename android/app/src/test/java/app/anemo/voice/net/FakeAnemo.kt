package app.anemo.voice.net

import okhttp3.Headers
import okhttp3.MultipartReader
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.json.JSONObject
import java.io.Closeable
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * A fake Anemo that speaks docs/device-contracts.md §2 and §4: the device WebSocket
 * (hello/welcome, ping/pong, events, notice, close codes) and the voice REST endpoints.
 */
class FakeAnemo : Closeable {
    val server = MockWebServer()
    val token = "anemo_phone_secret"
    val deviceName = "Pixel"

    /** What the client sent on any WebSocket, in order. */
    val received = LinkedBlockingQueue<JSONObject>()
    val connections = LinkedBlockingQueue<Connection>()
    val connectionCount = AtomicInteger()
    private val all = java.util.concurrent.CopyOnWriteArrayList<Connection>()
    val wsRequests = LinkedBlockingQueue<RecordedRequest>()

    /** The cursor and `missed` of the next welcome. */
    @Volatile var cursor: String? = "cur-0"
    @Volatile var missed = false
    @Volatile var notice: String? = null
    @Volatile var answerPings = true
    /** When set, the next hello is answered by closing with this code. */
    @Volatile var closeHelloWith: Int? = null

    val uploads = LinkedBlockingQueue<Upload>()
    @Volatile var turnResponse: MockResponse = json(202, TURN_STARTED)
    @Volatile var replyResponse: MockResponse = json(200, """{"decided":"approve","heard":"yes"}""")
    @Volatile var statusSay = "Nothing is running."

    data class Upload(val path: String, val url: String, val headers: Headers, val parts: Map<String, Part>)
    data class Part(val filename: String?, val contentType: String?, val bytes: ByteArray) {
        val text: String get() = String(bytes)
    }

    inner class Connection(val request: RecordedRequest) : WebSocketListener() {
        @Volatile lateinit var socket: WebSocket
        val hello = LinkedBlockingQueue<JSONObject>()

        override fun onOpen(webSocket: WebSocket, response: Response) {
            socket = webSocket
            all.add(this)
            connections.add(this)
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val m = JSONObject(text)
            received.add(m)
            when (m.optString("type")) {
                "hello" -> if (text.length > MAX_HELLO) webSocket.close(4400, "hello too long") else onHello(webSocket, m)
                "ping" -> if (answerPings) webSocket.send("""{"type":"pong"}""")
            }
        }

        private fun onHello(ws: WebSocket, m: JSONObject) {
            hello.add(m)
            val code = closeHelloWith
                ?: if (request.getHeader("Origin") != null) 4403 else null
                ?: if (m.optString("token") != token) 4401 else null
                ?: if (m.optString("kind") != "phone") 4400 else null
            if (code != null) {
                ws.close(code, "refused")
                return
            }
            val welcome = JSONObject()
                .put("type", "welcome")
                .put("device", JSONObject().put("id", "d1").put("name", deviceName).put("kind", "phone").put("trust", "normal"))
                .put("missed", missed)
                .put("cursor", cursor ?: JSONObject.NULL)
            ws.send(welcome.toString())
            notice?.let { ws.send(JSONObject().put("type", "notice").put("text", it).toString()) }
        }

        fun event(id: String, event: String, data: JSONObject) {
            socket.send(JSONObject().put("type", "event").put("id", id).put("event", event).put("data", data).toString())
        }
    }

    init {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.requestUrl?.encodedPath) {
                "/api/devices/ws" -> {
                    wsRequests.add(request)
                    connectionCount.incrementAndGet()
                    MockResponse().withWebSocketUpgrade(Connection(request))
                }
                "/api/voice/turns" -> upload(request, turnResponse)
                "/api/voice/replies" -> upload(request, replyResponse)
                else -> MockResponse().setResponseCode(404)
            }
        }
        server.start()
    }

    val address: Address get() = Address.parse(server.url("/").toString(), allowHttp = true)!!

    fun nextConnection(): Connection = checkNotNull(connections.poll(5, TimeUnit.SECONDS)) { "no connection" }
    fun nextUpload(): Upload = checkNotNull(uploads.poll(5, TimeUnit.SECONDS)) { "no upload" }

    private fun upload(request: RecordedRequest, response: MockResponse): MockResponse {
        if (request.getHeader("Authorization") != "Bearer $token") {
            uploads.add(Upload(request.requestUrl!!.encodedPath, request.requestUrl.toString(), request.headers, emptyMap()))
            return json(401, """{"error":{"code":"unauthorized","message":"Bad token"}}""")
        }
        val boundary = request.getHeader("Content-Type")!!.substringAfter("boundary=")
        val parts = mutableMapOf<String, Part>()
        MultipartReader(Buffer().write(request.body.readByteArray()), boundary).use { reader ->
            while (true) {
                val part = reader.nextPart() ?: break
                val disposition = part.headers["Content-Disposition"].orEmpty()
                val name = Regex("name=\"([^\"]+)\"").find(disposition)!!.groupValues[1]
                val filename = Regex("filename=\"([^\"]+)\"").find(disposition)?.groupValues?.get(1)
                parts[name] = Part(filename, part.headers["Content-Type"], part.body.readByteArray())
            }
        }
        val path = request.requestUrl!!.encodedPath
        uploads.add(Upload(path, request.requestUrl.toString(), request.headers, parts))
        // as the server does: the status command needs no audio; anything else does
        if (path == "/api/voice/turns" && parts["status"]?.text == "true") {
            return json(200, JSONObject().put("say", statusSay).toString())
        }
        if (parts["audio"] == null) return error(422, "empty_audio", "The recording is empty.")
        return response
    }

    override fun close() {
        all.forEach { it.socket.close(1001, null) }
        try {
            server.shutdown()
        } catch (e: java.io.IOException) {
            // MockWebServer gives up on WebSockets the client hasn't closed yet
        }
    }

    companion object {
        const val TURN_STARTED =
            """{"run_id":"r1","conversation_id":"c1","heard":"uh mail tom no tim","request":"Email Tim."}"""

        /** The longest hello the server reads. */
        const val MAX_HELLO = 4096

        /** The server's error shape: `{"error": {"code", "message"}}`. */
        fun error(status: Int, code: String, message: String): MockResponse = json(
            status,
            JSONObject().put("error", JSONObject().put("code", code).put("message", message)).toString(),
        )

        fun json(code: Int, body: String): MockResponse =
            MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)
    }
}
