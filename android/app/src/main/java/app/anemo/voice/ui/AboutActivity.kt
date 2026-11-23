package app.anemo.voice.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import app.anemo.voice.BuildConfig
import app.anemo.voice.ui.theme.AnemoTheme

/** About Anemo Voice, and the licences of the software inside it (from assets/licenses/). */
class AboutActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            AnemoTheme {
                var which by rememberSaveable { mutableIntStateOf(0) }
                val asset = if (which == 0) NOTICES else ORT_NOTICES
                val text = remember(asset) { read(asset) }
                AboutScreen(
                    version = BuildConfig.VERSION_NAME,
                    which = which,
                    fileName = asset.substringAfterLast('/'),
                    text = text,
                    onWhich = { which = it },
                    onBack = ::finish,
                )
            }
        }
    }

    private fun read(asset: String): String = assets.open(asset).bufferedReader().use { it.readText() }

    companion object {
        const val NOTICES = "licenses/THIRD-PARTY-NOTICES.txt"
        const val ORT_NOTICES = "licenses/onnxruntime-third-party-notices.txt"
    }
}
