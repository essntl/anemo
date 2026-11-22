package app.anemo.voice.ui

import android.app.Activity
import android.graphics.Typeface
import android.os.Bundle
import android.widget.ScrollView
import android.widget.TextView
import app.anemo.voice.BuildConfig

/** About Anemo Voice, and the licences of the software inside it (from assets/licenses/). */
class AboutActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val text = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            textSize = 11f
            setTextIsSelectable(true)
        }
        val content = column().apply {
            addView(heading("Anemo Voice ${BuildConfig.VERSION_NAME}"))
            addView(label("Talk to your Anemo from this phone. Part of Anemo, GNU GPL v2."))
            addView(row(
                button("Licences") { text.text = read(NOTICES) },
                button("ONNX Runtime notices") { text.text = read(ORT_NOTICES) },
            ))
            addView(text)
        }
        text.text = read(NOTICES)
        setContentView(ScrollView(this).apply {
            addView(content)
            clipToPadding = false
            padForSystemBars()
        })
    }

    private fun read(asset: String): String = assets.open(asset).bufferedReader().use { it.readText() }

    companion object {
        const val NOTICES = "licenses/THIRD-PARTY-NOTICES.txt"
        const val ORT_NOTICES = "licenses/onnxruntime-third-party-notices.txt"
    }
}
