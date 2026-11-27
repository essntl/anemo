package app.anemo.voice.service

import app.anemo.voice.core.ListenState
import java.util.concurrent.CopyOnWriteArraySet

/** The connection to Anemo, as the notification and the app show it. */
sealed interface Connection {
    data object Off : Connection
    data object Connecting : Connection
    data class Connected(val deviceName: String) : Connection
    data class Retrying(val inSeconds: Long) : Connection

    /** Stopped for good; [message] says why (a close code of device-contracts.md §2). */
    data class Refused(val message: String) : Connection
}

data class Status(
    val listen: ListenState = ListenState.Stopped,
    val connection: Connection = Connection.Off,
    val activeRuns: Int = 0,
    val notice: String? = null,
    val error: String? = null,
    /** Voice mode is on: the microphone opens again after each answer. */
    val voiceMode: Boolean = false,
)

/** In-process status of the listening service, for the activity and the tile. */
object StatusBus {
    @Volatile var status = Status()
        private set

    private val listeners = CopyOnWriteArraySet<(Status) -> Unit>()

    /** Listeners hear of a change only: each one rebuilds and posts the notification, and
     *  callbacks repeat states (speech recognition available again, the same run count). */
    fun update(change: (Status) -> Status) {
        val (before, next) = synchronized(this) { status to change(status).also { status = it } }
        if (next != before) listeners.forEach { it(next) }
    }

    /** History changed: the app reloads its list. */
    private val historyListeners = CopyOnWriteArraySet<() -> Unit>()

    fun historyChanged() = historyListeners.forEach { it() }

    fun observe(listener: (Status) -> Unit) = listeners.add(listener)
    fun forget(listener: (Status) -> Unit) = listeners.remove(listener)
    fun observeHistory(listener: () -> Unit) = historyListeners.add(listener)
    fun forgetHistory(listener: () -> Unit) = historyListeners.remove(listener)
}
