package app.anemo.voice.service

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import app.anemo.voice.ui.MainActivity

/**
 * The second quick-settings tile: switches voice mode on and off (the microphone opens
 * again after each answer, without the wake word). When listening isn't running, it
 * starts it with voice mode on; when Android doesn't allow that, it opens the app.
 */
class VoiceModeTileService : TileService() {
    private val main = Handler(Looper.getMainLooper())
    private val listener: (Status) -> Unit = { main.post { refresh() } }

    override fun onStartListening() {
        StatusBus.observe(listener)
        refresh()
    }

    override fun onStopListening() {
        StatusBus.forget(listener)
    }

    override fun onClick() {
        if (ListenService.running) {
            val action = if (StatusBus.status.voiceMode) ListenService.VOICE_MODE_OFF else ListenService.VOICE_MODE_ON
            startService(ListenService.intent(this, action))
            return
        }
        if (Launcher.problem(this) != null) {
            openApp()
            return
        }
        try {
            Launcher.start(this, voiceMode = true)
        } catch (e: IllegalStateException) {
            openApp() // ForegroundServiceStartNotAllowedException and the like
        } catch (e: SecurityException) {
            openApp()
        }
    }

    @SuppressLint("StartActivityAndCollapseDeprecated")
    private fun openApp() {
        val intent = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 1, intent, PendingIntent.FLAG_IMMUTABLE))
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(intent)
        }
    }

    private fun refresh() {
        val tile = qsTile ?: return
        val on = ListenService.running && StatusBus.status.voiceMode
        tile.state = if (on) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        tile.subtitle = if (on) "On" else "Off"
        tile.updateTile()
    }
}
