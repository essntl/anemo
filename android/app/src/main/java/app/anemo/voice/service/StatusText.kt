package app.anemo.voice.service

/** The words for the connection and the running requests, shared by the notification and the app. */
object StatusText {
    /** What to say about [connection], or null when there is nothing to say (connected, off). */
    fun connection(connection: Connection): String? = when (connection) {
        is Connection.Refused -> connection.message
        is Connection.Retrying -> "Can't reach Anemo, trying again in ${connection.inSeconds} s"
        Connection.Connecting -> "Connecting to Anemo…"
        is Connection.Connected, Connection.Off -> null
    }

    /** "1 request working", "3 requests working", or null for none. */
    fun activeRuns(count: Int): String? = when {
        count == 1 -> "1 request working"
        count > 1 -> "$count requests working"
        else -> null
    }
}
