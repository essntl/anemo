package app.anemo.voice.service

import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.service.quicksettings.TileService
import android.content.ComponentName
import app.anemo.voice.core.ListenState
import app.anemo.voice.settings.AndroidSettingsStore
import app.anemo.voice.settings.VoiceSettings

/**
 * The foreground service (`foregroundServiceType="microphone"`) that listens for the wake
 * word. Its notification goes up before the microphone opens and stays while it runs;
 * Stop ends both. Android only allows starting it while the app is in use, so after a
 * reboot the user opens the app or taps the tile once (no boot receiver, on purpose).
 */
class ListenService : Service() {
    private var runtime: VoiceRuntime? = null
    private var settings = VoiceSettings()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ListenNotification.createChannel(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            START -> begin()
            PAUSE -> runtime?.pause()
            RESUME -> runtime?.resume()
            STATUS -> runtime?.status()
            STOP -> {
                end()
                return START_NOT_STICKY
            }
            else -> if (runtime == null) stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun begin() {
        if (runtime != null) return
        settings = AndroidSettingsStore(this).load()
        // The notification first: never a microphone without it.
        val first = Status(listen = ListenState.Listening, connection = Connection.Connecting)
        StatusBus.update { first }
        val notification = ListenNotification.build(this, first, settings.wakeWordName)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            startForeground(ListenNotification.ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } else {
            startForeground(ListenNotification.ID, notification)
        }
        StatusBus.observe(statusListener)
        try {
            runtime = VoiceRuntime(this, settings, StatusBus::update).also { it.start() }
        } catch (e: Exception) {
            // models missing or broken, microphone busy, …: say so and stop listening
            runtime?.stop()
            runtime = null
            StatusBus.forget(statusListener)
            StatusBus.update { Status(error = "Anemo Voice could not start: ${e.javaClass.simpleName}") }
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
        refreshTile()
    }

    private fun end() {
        StatusBus.forget(statusListener)
        runtime?.stop()
        runtime = null
        StatusBus.update { Status() }
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        refreshTile()
    }

    private val statusListener: (Status) -> Unit = { status ->
        getSystemService(NotificationManager::class.java)
            .notify(ListenNotification.ID, ListenNotification.build(this, status, settings.wakeWordName))
    }

    override fun onDestroy() {
        if (runtime != null) end()
        super.onDestroy()
    }

    private fun refreshTile() {
        TileService.requestListeningState(this, ComponentName(this, ListenTileService::class.java))
    }

    companion object {
        const val START = "app.anemo.voice.START"
        const val PAUSE = "app.anemo.voice.PAUSE"
        const val RESUME = "app.anemo.voice.RESUME"
        const val STATUS = "app.anemo.voice.STATUS"
        const val STOP = "app.anemo.voice.STOP"

        fun intent(context: Context, action: String): Intent =
            Intent(context, ListenService::class.java).setAction(action)

        val running: Boolean get() = StatusBus.status.listen != ListenState.Stopped
    }
}
