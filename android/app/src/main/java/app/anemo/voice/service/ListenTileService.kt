package app.anemo.voice.service

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import app.anemo.voice.core.ListenState
import app.anemo.voice.ui.MainActivity

/**
 * The quick-settings tile: switches listening on and off. When Android doesn't let the
 * tile start the microphone service, or something is missing, it opens the app instead.
 */
class ListenTileService : TileService() {
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
            startService(ListenService.intent(this, ListenService.STOP))
            return
        }
        if (Launcher.problem(this) != null) {
            openApp()
            return
        }
        try {
            Launcher.start(this)
        } catch (e: IllegalStateException) {
            openApp() // ForegroundServiceStartNotAllowedException and the like
        } catch (e: SecurityException) {
            openApp()
        }
    }

    @SuppressLint("StartActivityAndCollapseDeprecated")
    private fun openApp() {
        val intent = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra(MainActivity.EXTRA_START, true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE))
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(intent)
        }
    }

    private fun refresh() {
        val tile = qsTile ?: return
        val status = StatusBus.status
        tile.state = if (ListenService.running) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        tile.subtitle = when {
            !ListenService.running -> "Off"
            status.listen == ListenState.Paused -> "Paused"
            else -> "Listening"
        }
        tile.updateTile()
    }
}
