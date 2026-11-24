package app.anemo.voice.service

import android.app.NotificationManager
import android.app.Service
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.service.quicksettings.TileService
import app.anemo.voice.core.ListenState
import app.anemo.voice.core.VoiceModeCause
import app.anemo.voice.core.VoiceSession
import app.anemo.voice.settings.AndroidSettingsStore
import app.anemo.voice.settings.VoiceSettings
import app.anemo.voice.ui.MainActivity

/**
 * The foreground service (`foregroundServiceType="microphone"`) that listens for the wake
 * word. Its notification goes up before the microphone opens; while it runs, the service
 * checks that the notification can still be seen (notifications on, the Listening channel
 * not blocked, not swiped away) and stops listening when it can't. Android only allows
 * starting it while the app is in use, so after a reboot the user opens the app or taps the
 * tile once (no boot receiver, on purpose).
 */
class ListenService : Service() {
    private var session: VoiceSession? = null
    private var settings = VoiceSettings()
    private val main = Handler(Looper.getMainLooper())

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ListenNotification.createChannel(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            START -> begin(voiceMode = intent.getBooleanExtra(EXTRA_VOICE_MODE, false))
            VOICE_MODE_ON -> session?.setVoiceMode(true, cause(intent))
            VOICE_MODE_OFF -> session?.setVoiceMode(false, cause(intent))
            PAUSE -> session?.pause()
            RESUME -> session?.resume()
            STATUS -> session?.status()
            STOP -> end(null)
            HIDDEN -> end("The notification was hidden, so Anemo Voice stopped listening.")
            else -> if (session == null) stopSelf()
        }
        return START_NOT_STICKY
    }

    /** Only the tile and the notification switch voice mode from outside the voice loop. */
    private fun cause(intent: Intent): VoiceModeCause =
        if (intent.getStringExtra(EXTRA_CAUSE) == FROM_NOTIFICATION) VoiceModeCause.Notification else VoiceModeCause.Tile

    /** [voiceMode]: the voice mode tile started listening, so voice mode goes on at once. */
    private fun begin(voiceMode: Boolean) {
        if (session != null) {
            if (voiceMode) session?.setVoiceMode(true, VoiceModeCause.Tile)
            return
        }
        settings = AndroidSettingsStore(this).load()
        val first = Status(listen = ListenState.Listening, connection = Connection.Connecting)
        // The notification first: never a microphone without it.
        try {
            val notification = ListenNotification.build(this, first, settings.wakeWordName)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                startForeground(ListenNotification.ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            } else {
                startForeground(ListenNotification.ID, notification)
            }
        } catch (e: Exception) {
            // Android 14+ refuses a microphone service started from the background (a tile
            // tap with the app closed, for example): show the app instead, never crash.
            StatusBus.update { Status(error = "Android didn't allow listening to start here. Start it in the app.") }
            stopSelf()
            openApp()
            return
        }
        if (!ListenNotification.visible(this)) {
            end("Notifications for Anemo Voice are off, so it doesn't listen.")
            return
        }
        StatusBus.update { first }
        StatusBus.observe(statusListener)
        val filter = IntentFilter().apply {
            addAction(NotificationManager.ACTION_NOTIFICATION_CHANNEL_BLOCK_STATE_CHANGED)
            addAction(NotificationManager.ACTION_APP_BLOCK_STATE_CHANGED)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(visibility, filter, RECEIVER_NOT_EXPORTED) // system broadcasts still arrive
        } else {
            registerReceiver(visibility, filter)
        }
        var made: VoiceSession? = null
        try {
            made = VoiceRuntime.build(this, settings, StatusBus::update) { message -> main.post { end(message) } }
            made.start()
            session = made
            if (voiceMode) made.setVoiceMode(true, VoiceModeCause.Tile)
        } catch (e: Exception) {
            made?.stop() // a half-started session: stop the connection and the loop again
            end("Anemo Voice could not start (${e.message ?: e.javaClass.simpleName}).")
            return
        }
        refreshTile()
    }

    /** Stops listening; [problem] says why when it wasn't the user's choice. */
    private fun end(problem: String?) {
        StatusBus.forget(statusListener)
        runCatching { unregisterReceiver(visibility) }
        session?.stop()
        session = null
        StatusBus.update { Status(error = problem) }
        stopForeground(STOP_FOREGROUND_REMOVE)
        if (problem != null) ListenNotification.showProblem(this, problem)
        stopSelf()
        refreshTile()
    }

    private val statusListener: (Status) -> Unit = { status ->
        main.post {
            if (session == null) return@post
            if (!ListenNotification.visible(this)) {
                end("Notifications for Anemo Voice were turned off, so it stopped listening.")
            } else {
                getSystemService(NotificationManager::class.java)
                    .notify(ListenNotification.ID, ListenNotification.build(this, status, settings.wakeWordName))
            }
        }
    }

    /** Notifications or the Listening channel blocked while listening: stop. */
    private val visibility = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (session != null && !ListenNotification.visible(context)) {
                end("Notifications for Anemo Voice were turned off, so it stopped listening.")
            }
        }
    }

    private fun openApp() {
        try {
            startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: RuntimeException) {
            // not allowed from the background either: the status says what to do
        }
    }

    override fun onDestroy() {
        if (session != null) end(null)
        super.onDestroy()
    }

    private fun refreshTile() {
        TileService.requestListeningState(this, ComponentName(this, ListenTileService::class.java))
        TileService.requestListeningState(this, ComponentName(this, VoiceModeTileService::class.java))
    }

    companion object {
        const val START = "app.anemo.voice.START"
        const val PAUSE = "app.anemo.voice.PAUSE"
        const val RESUME = "app.anemo.voice.RESUME"
        const val STATUS = "app.anemo.voice.STATUS"
        const val STOP = "app.anemo.voice.STOP"
        const val HIDDEN = "app.anemo.voice.HIDDEN"
        const val VOICE_MODE_ON = "app.anemo.voice.VOICE_MODE_ON"
        const val VOICE_MODE_OFF = "app.anemo.voice.VOICE_MODE_OFF"

        /** With [START]: turn voice mode on as soon as listening started. */
        const val EXTRA_VOICE_MODE = "voice_mode"

        /** With [VOICE_MODE_ON] / [VOICE_MODE_OFF]: [FROM_NOTIFICATION], else the tile. */
        const val EXTRA_CAUSE = "cause"
        const val FROM_NOTIFICATION = "notification"

        fun intent(context: Context, action: String): Intent =
            Intent(context, ListenService::class.java).setAction(action)

        val running: Boolean get() = StatusBus.status.listen != ListenState.Stopped
    }
}
