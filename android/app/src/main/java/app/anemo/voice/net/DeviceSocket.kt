package app.anemo.voice.net

import app.anemo.voice.core.DeviceEvent
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * The phone's one WebSocket to `/api/devices/ws` (device-contracts.md §2), kept open while
 * the service runs: `hello` first (the token travels only in it), a ping every 20 s,
 * reconnects with back-off and resumes with `last_id`. Close codes 4400, 4401, 4403 and
 * 4409 stop it for good (reconnecting would not help, or would fight the newer connection).
 *
 * Everything runs on [executor] (one thread); the [Listener] is called there.
 */
class DeviceSocket(
    private val client: OkHttpClient,
    private val url: HttpUrl,
    private val token: String,
    private val version: String,
    private val listener: Listener,
    private val executor: ScheduledExecutorService,
    private val backoff: Backoff = Backoff(),
    private val pingIntervalMs: Long = 20_000,
    private val silenceTimeoutMs: Long = 50_000,
) {
    interface Listener {
        fun onConnected(deviceName: String, missed: Boolean) {}
        fun onEvent(event: DeviceEvent) {}
        fun onNotice(text: String) {}
        fun onDisconnected(retryInMs: Long) {}
        fun onStopped(reason: StopReason) {}
    }

    enum class StopReason(val code: Int) {
        BadHello(4400),
        BadToken(4401),
        OriginRefused(4403),
        Replaced(4409),
        ;

        companion object {
            fun of(code: Int): StopReason? = entries.firstOrNull { it.code == code }
        }
    }

    private var generation = 0
    private var socket: WebSocket? = null
    private var running = false
    private var lastReceivedAt = 0L
    private var ticker: ScheduledFuture<*>? = null
    private var retry: ScheduledFuture<*>? = null

    /** The id to resume from: the welcome's cursor, then each event's id. */
    @Volatile
    var lastId: String? = null
        private set

    fun start() = executor.execute {
        if (running) return@execute
        running = true
        connect()
    }

    fun stop() = executor.execute {
        running = false
        generation++
        cancelTimers()
        socket?.close(1000, null)
        socket = null
    }

    private fun connect() {
        val gen = ++generation
        // No Origin header: OkHttp sends none, and the server closes with 4403 if one comes.
        val request = Request.Builder().url(url).build()
        lastReceivedAt = now()
        socket = client.newWebSocket(request, Callbacks(gen))
        ticker = executor.scheduleWithFixedDelay(
            { if (gen == generation) tick() },
            pingIntervalMs,
            pingIntervalMs,
            TimeUnit.MILLISECONDS,
        )
    }

    private fun tick() {
        if (now() - lastReceivedAt > silenceTimeoutMs) {
            dropped() // the connection went quiet: treat it as lost
        } else {
            socket?.send(Protocol.ping())
        }
    }

    private fun onOpen(ws: WebSocket) {
        ws.send(Protocol.hello(token, version, lastId))
    }

    private fun onMessage(text: String) {
        lastReceivedAt = now()
        when (val m = Protocol.parse(text)) {
            is ServerMessage.Welcome -> {
                backoff.reset()
                if (m.cursor != null) lastId = m.cursor
                listener.onConnected(m.deviceName, m.missed)
            }
            is ServerMessage.Event -> {
                lastId = m.id
                m.event?.let(listener::onEvent)
            }
            is ServerMessage.Notice -> listener.onNotice(m.text)
            ServerMessage.Pong, ServerMessage.Unknown -> Unit
        }
    }

    private fun onClosed(code: Int) {
        val reason = StopReason.of(code)
        if (reason == null) {
            dropped()
            return
        }
        running = false
        generation++
        cancelTimers()
        socket = null
        listener.onStopped(reason)
    }

    private fun dropped() {
        generation++
        cancelTimers()
        socket?.cancel()
        socket = null
        if (!running) return
        val delay = backoff.next()
        listener.onDisconnected(delay)
        retry = executor.schedule({ if (running && socket == null) connect() }, delay, TimeUnit.MILLISECONDS)
    }

    private fun cancelTimers() {
        ticker?.cancel(false)
        retry?.cancel(false)
        ticker = null
        retry = null
    }

    private fun now(): Long = System.nanoTime() / 1_000_000

    /** OkHttp's callbacks, moved onto [executor] and dropped once their connection is old. */
    private inner class Callbacks(private val gen: Int) : WebSocketListener() {
        private fun onExecutor(block: () -> Unit) {
            try {
                executor.execute { if (gen == generation) block() }
            } catch (e: RejectedExecutionException) {
                // shut down: the service is gone
            }
        }

        override fun onOpen(webSocket: WebSocket, response: Response) = onExecutor { onOpen(webSocket) }

        override fun onMessage(webSocket: WebSocket, text: String) = onExecutor { onMessage(text) }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
            onExecutor { onClosed(code) }
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = onExecutor { onClosed(code) }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) =
            onExecutor { dropped() }
    }
}
