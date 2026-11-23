package app.anemo.voice.ui

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import app.anemo.voice.core.HistoryEntry
import app.anemo.voice.core.ListenState
import app.anemo.voice.history.HistoryDatabase
import app.anemo.voice.history.RoomHistoryStore
import app.anemo.voice.service.Launcher
import app.anemo.voice.service.ListenService
import app.anemo.voice.service.Status
import app.anemo.voice.service.StatusBus
import app.anemo.voice.settings.AndroidSettingsStore
import app.anemo.voice.ui.theme.AnemoTheme
import java.util.concurrent.Executors

/**
 * The app's main screen: listening on or off, pause, status, and the last 50 requests
 * (heard, request, spoken answer; tap one to open its chat in Anemo).
 */
class MainActivity : ComponentActivity() {
    private val io = Executors.newSingleThreadExecutor()

    private var status by mutableStateOf(StatusBus.status)
    private var wakeWord by mutableStateOf("")
    private var notSetUp by mutableStateOf(false)
    private var problem by mutableStateOf<ProblemLine?>(null)
    private var history by mutableStateOf<List<HistoryEntry>?>(null)

    private val statusListener: (Status) -> Unit = { runOnUiThread { showStatus() } }
    private val historyListener: () -> Unit = { loadHistory() }

    /** Asked for before listening starts; whatever the answer, [startIfReady] says what is missing. */
    private val permissions =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { startIfReady() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            AnemoTheme {
                MainScreen(
                    card = ListenCards.of(status, wakeWord, notSetUp),
                    problem = problem,
                    history = history,
                    wakeWord = wakeWord,
                    onAction = ::act,
                    onSettings = { startActivity(Intent(this, SettingsActivity::class.java)) },
                    onAbout = { startActivity(Intent(this, AboutActivity::class.java)) },
                    onOpen = { openChat(it.chatLink) },
                )
            }
        }
        if (startedFromTile(intent)) askPermissionsThenStart()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (startedFromTile(intent)) askPermissionsThenStart()
    }

    /**
     * Only the tile may ask the app to start listening when it opens: it goes through the
     * non-exported alias [TILE_ALIAS], which no other app can open.
     */
    private fun startedFromTile(intent: Intent?): Boolean =
        intent?.component?.className == TILE_ALIAS && intent.getBooleanExtra(EXTRA_START, false)

    override fun onResume() {
        super.onResume()
        StatusBus.observe(statusListener)
        StatusBus.observeHistory(historyListener)
        showStatus()
        loadHistory()
    }

    override fun onPause() {
        StatusBus.forget(statusListener)
        StatusBus.forgetHistory(historyListener)
        super.onPause()
    }

    override fun onDestroy() {
        io.shutdown()
        super.onDestroy()
    }

    private fun act(action: CardAction) {
        when (action) {
            CardAction.Start -> if (!ListenService.running) askPermissionsThenStart()
            CardAction.Stop -> if (ListenService.running) startService(ListenService.intent(this, ListenService.STOP))
            CardAction.Pause -> Launcher.send(this, ListenService.PAUSE)
            CardAction.Resume -> Launcher.send(this, ListenService.RESUME)
            CardAction.Status -> Launcher.send(this, ListenService.STATUS)
        }
    }

    private fun askPermissionsThenStart() {
        val missing = buildList {
            add(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) add(Manifest.permission.POST_NOTIFICATIONS)
        }.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isEmpty()) startIfReady() else permissions.launch(missing.toTypedArray())
    }

    private fun startIfReady() {
        val p = Launcher.problem(this)
        if (p != null) {
            problem = ListenCards.problemLine(p)
            notSetUp = true
            return
        }
        problem = null
        Launcher.start(this) // the app is in the foreground: Android allows it
    }

    private fun showStatus() {
        val s = StatusBus.status
        status = s
        wakeWord = AndroidSettingsStore(this).load().wakeWordName
        if (s.listen != ListenState.Stopped) {
            problem = null
            notSetUp = false
            return
        }
        val p = Launcher.problem(this)
        notSetUp = p != null
        // a setup problem is shown again as it is now (fixed in Settings meanwhile: gone);
        // another message (no browser) stays until listening starts
        val shown = problem
        if (shown == null || shown.fromSetup) problem = p?.let { ListenCards.problemLine(it) }
    }

    private fun loadHistory() {
        io.execute {
            val entries = RoomHistoryStore(HistoryDatabase.get(this).requests()).recent()
            runOnUiThread { history = entries }
        }
    }

    private fun openChat(link: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link)))
        } catch (e: ActivityNotFoundException) {
            problem = ProblemLine("No browser to open $link", opensSettings = false, fromSetup = false)
        }
    }

    companion object {
        const val EXTRA_START = "start"
        const val TILE_ALIAS = "app.anemo.voice.ui.StartFromTile"
    }
}
