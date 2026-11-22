package app.anemo.voice.ui

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import app.anemo.voice.core.HistoryEntry
import app.anemo.voice.core.ListenState
import app.anemo.voice.history.HistoryDatabase
import app.anemo.voice.history.RoomHistoryStore
import app.anemo.voice.service.Launcher
import app.anemo.voice.service.ListenNotification
import app.anemo.voice.service.ListenService
import app.anemo.voice.service.Status
import app.anemo.voice.service.StatusBus
import app.anemo.voice.settings.AndroidSettingsStore
import java.text.DateFormat
import java.util.Date
import java.util.concurrent.Executors

/**
 * The app's main screen: listening on or off, pause, status, and the last 50 requests
 * (heard, request, spoken answer; tap one to open its chat in Anemo).
 */
class MainActivity : Activity() {
    private val io = Executors.newSingleThreadExecutor()
    private lateinit var title: TextView
    private lateinit var detail: TextView
    private lateinit var problem: TextView
    private lateinit var toggle: android.widget.Button
    private lateinit var pause: android.widget.Button
    private val adapter = HistoryAdapter()

    private val statusListener: (Status) -> Unit = { runOnUiThread { showStatus() } }
    private val historyListener: () -> Unit = { loadHistory() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        title = label("", 20f)
        detail = label("")
        problem = label("")
        toggle = button("Start listening") { toggleListening() }
        pause = button("Pause") {
            Launcher.send(this, if (StatusBus.status.listen == ListenState.Paused) ListenService.RESUME else ListenService.PAUSE)
        }
        val status = button("Status") { Launcher.send(this, ListenService.STATUS) }
        val settings = button("Settings") { startActivity(Intent(this, SettingsActivity::class.java)) }

        val header = column().apply {
            addView(title)
            addView(detail)
            addView(problem)
            addView(row(toggle, pause))
            addView(row(status, settings))
            addView(heading("Recent requests"))
        }
        val list = ListView(this).apply {
            addHeaderView(header, null, false)
            adapter = this@MainActivity.adapter
            setOnItemClickListener { _, _, position, _ ->
                (getItemAtPosition(position) as? HistoryEntry)?.let { openChat(it.chatLink) }
            }
        }
        setContentView(list)
        if (intent.getBooleanExtra(EXTRA_START, false)) askPermissionsThenStart()
    }

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

    private fun toggleListening() {
        if (ListenService.running) {
            startService(ListenService.intent(this, ListenService.STOP))
        } else {
            askPermissionsThenStart()
        }
    }

    private fun askPermissionsThenStart() {
        val missing = buildList {
            add(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) add(Manifest.permission.POST_NOTIFICATIONS)
        }.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isEmpty()) startIfReady() else requestPermissions(missing.toTypedArray(), REQUEST_PERMISSIONS)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_PERMISSIONS) startIfReady()
    }

    private fun startIfReady() {
        val p = Launcher.problem(this)
        if (p != null) {
            problem.text = p.message
            return
        }
        problem.text = ""
        Launcher.start(this) // the app is in the foreground: Android allows it
    }

    private fun showStatus() {
        val s = StatusBus.status
        val wakeWord = AndroidSettingsStore(this).load().wakeWordName
        val running = s.listen != ListenState.Stopped
        title.text = if (running) ListenNotification.title(s, wakeWord) else "Not listening"
        detail.text = if (running) ListenNotification.detail(s) else s.error.orEmpty()
        toggle.text = if (running) "Stop listening" else "Start listening"
        pause.isEnabled = running
        pause.text = if (s.listen == ListenState.Paused) "Resume" else "Pause"
        if (!running && problem.text.isEmpty()) Launcher.problem(this)?.let { problem.text = it.message }
        if (running) problem.text = ""
    }

    private fun loadHistory() {
        io.execute {
            val entries = RoomHistoryStore(HistoryDatabase.get(this).requests()).recent()
            runOnUiThread { adapter.show(entries) }
        }
    }

    private fun openChat(link: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link)))
        } catch (e: ActivityNotFoundException) {
            problem.text = "No browser to open $link"
        }
    }

    private inner class HistoryAdapter : BaseAdapter() {
        private var entries: List<HistoryEntry> = emptyList()
        private val time = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT)

        fun show(list: List<HistoryEntry>) {
            entries = list
            notifyDataSetChanged()
        }

        override fun getCount() = entries.size
        override fun getItem(position: Int) = entries[position]
        override fun getItemId(position: Int) = position.toLong()

        override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
            val e = entries[position]
            val view = (convertView as? LinearLayout) ?: column().apply {
                repeat(4) { addView(label("")) }
            }
            (view.getChildAt(0) as TextView).text = e.request
            (view.getChildAt(1) as TextView).text = "Heard: ${e.heard}"
            (view.getChildAt(2) as TextView).text = e.answer?.let { "Answer: $it" } ?: "Working…"
            (view.getChildAt(3) as TextView).text = "${time.format(Date(e.createdAt))} · open the chat"
            return view
        }
    }

    companion object {
        const val EXTRA_START = "start"
        private const val REQUEST_PERMISSIONS = 1
    }
}
