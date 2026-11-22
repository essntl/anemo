package app.anemo.voice.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import app.anemo.voice.R
import app.anemo.voice.core.ListenState
import app.anemo.voice.ui.MainActivity

/** The permanent notification of the listening service, with Pause / Resume, Status and Stop. */
object ListenNotification {
    const val ID = 1
    private const val CHANNEL = "listening"

    fun createChannel(context: Context) {
        val channel = NotificationChannel(CHANNEL, "Listening", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Shown whenever Anemo Voice can hear the microphone"
            setShowBadge(false)
        }
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    fun build(context: Context, status: Status, wakeWord: String): Notification {
        val paused = status.listen == ListenState.Paused
        val open = PendingIntent.getActivity(
            context, 0, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = Notification.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title(status, wakeWord))
            .setContentText(detail(status))
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .addAction(action(context, if (paused) "Resume" else "Pause", if (paused) ListenService.RESUME else ListenService.PAUSE, 1))
            .addAction(action(context, "Status", ListenService.STATUS, 2))
            .addAction(action(context, "Stop", ListenService.STOP, 3))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
        }
        return builder.build()
    }

    /** The title, as spec 05 words it while listening. */
    fun title(status: Status, wakeWord: String): String = when (status.listen) {
        ListenState.Paused -> "Anemo is paused"
        ListenState.Recording -> "Anemo is listening to you"
        ListenState.Speaking -> "Anemo is speaking"
        else -> "Anemo is listening for $wakeWord"
    }

    fun detail(status: Status): String {
        val parts = mutableListOf<String>()
        status.error?.let { parts += it }
        when (val c = status.connection) {
            is Connection.Refused -> parts += c.message
            is Connection.Retrying -> parts += "Can't reach Anemo, trying again in ${c.inSeconds} s"
            Connection.Connecting -> parts += "Connecting to Anemo…"
            is Connection.Connected, Connection.Off -> Unit
        }
        if (status.activeRuns == 1) parts += "1 request working"
        if (status.activeRuns > 1) parts += "${status.activeRuns} requests working"
        status.notice?.let { parts += it }
        return parts.joinToString(" · ").ifEmpty { "Connected" }
    }

    private fun action(context: Context, label: String, what: String, code: Int): Notification.Action {
        val intent = Intent(context, ListenService::class.java).setAction(what)
        val pi = PendingIntent.getService(context, code, intent, PendingIntent.FLAG_IMMUTABLE)
        return Notification.Action.Builder(null, label, pi).build()
    }
}
