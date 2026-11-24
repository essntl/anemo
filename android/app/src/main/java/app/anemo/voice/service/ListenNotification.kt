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

/**
 * The permanent notification of the listening service, with Pause / Resume, Voice mode /
 * End voice mode, and Stop. (Android shows three buttons at most: Status is in the app.)
 */
object ListenNotification {
    const val ID = 1
    private const val PROBLEM_ID = 2
    const val CHANNEL = "listening"
    private const val PROBLEMS = "problems"

    fun createChannel(context: Context) {
        val channel = NotificationChannel(CHANNEL, "Listening", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Shown whenever Anemo Voice can hear the microphone"
            setShowBadge(false)
        }
        val problems = NotificationChannel(PROBLEMS, "Problems", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "Why Anemo Voice stopped listening"
        }
        context.getSystemService(NotificationManager::class.java).createNotificationChannels(listOf(channel, problems))
    }

    /**
     * Whether the listening notification can be seen: the app's notifications are on and
     * the Listening channel isn't blocked. Anemo Voice doesn't listen otherwise.
     */
    fun visible(context: Context): Boolean {
        createChannel(context)
        val nm = context.getSystemService(NotificationManager::class.java)
        return nm.areNotificationsEnabled() &&
            nm.getNotificationChannel(CHANNEL)?.importance != NotificationManager.IMPORTANCE_NONE
    }

    /** After listening stopped by itself: says why, until tapped or swiped away. */
    fun showProblem(context: Context, text: String) {
        createChannel(context)
        val open = PendingIntent.getActivity(
            context, 1, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        val n = Notification.Builder(context, PROBLEMS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Anemo Voice stopped listening")
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        context.getSystemService(NotificationManager::class.java).notify(PROBLEM_ID, n)
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
            // swiped away (Android 14+ allows it): stop listening, as it can't be seen any more
            .setDeleteIntent(service(context, ListenService.HIDDEN, 4))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .addAction(action(context, if (paused) "Resume" else "Pause", if (paused) ListenService.RESUME else ListenService.PAUSE, 1))
            .addAction(voiceModeAction(context, status.voiceMode))
            .addAction(action(context, "Stop", ListenService.STOP, 3))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
        }
        return builder.build()
    }

    /** The title: "Listening" while recording (spec 07), "Voice mode · …" in voice mode. */
    fun title(status: Status, wakeWord: String): String = StatusText.withVoiceMode(
        when (status.listen) {
            ListenState.Paused -> "Anemo is paused"
            ListenState.Recording -> "Listening"
            ListenState.Speaking -> "Anemo is speaking"
            else -> "Anemo is listening for $wakeWord"
        },
        status.voiceMode,
    )

    fun detail(status: Status): String {
        val parts = mutableListOf<String>()
        status.error?.let { parts += it }
        StatusText.connection(status.connection)?.let { parts += it }
        StatusText.activeRuns(status.activeRuns)?.let { parts += it }
        status.notice?.let { parts += it }
        return parts.joinToString(" · ").ifEmpty { "Connected" }
    }

    private fun action(context: Context, label: String, what: String, code: Int): Notification.Action =
        Notification.Action.Builder(null, label, service(context, what, code)).build()

    private fun voiceModeAction(context: Context, on: Boolean): Notification.Action {
        val intent = Intent(context, ListenService::class.java)
            .setAction(if (on) ListenService.VOICE_MODE_OFF else ListenService.VOICE_MODE_ON)
            .putExtra(ListenService.EXTRA_CAUSE, ListenService.FROM_NOTIFICATION)
        val pending = PendingIntent.getService(context, if (on) 6 else 5, intent, PendingIntent.FLAG_IMMUTABLE)
        return Notification.Action.Builder(null, if (on) "End voice mode" else "Voice mode", pending).build()
    }

    private fun service(context: Context, what: String, code: Int): PendingIntent =
        PendingIntent.getService(
            context, code, Intent(context, ListenService::class.java).setAction(what), PendingIntent.FLAG_IMMUTABLE,
        )
}
