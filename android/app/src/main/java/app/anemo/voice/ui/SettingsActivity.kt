package app.anemo.voice.ui

import android.net.Uri
import android.os.Bundle
import android.speech.tts.TextToSpeech
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import app.anemo.voice.audio.AndroidSpeaker
import app.anemo.voice.ml.ModelFiles
import app.anemo.voice.service.Launcher
import app.anemo.voice.service.ListenService
import app.anemo.voice.settings.AndroidSettingsStore
import app.anemo.voice.settings.VoiceSettings
import app.anemo.voice.settings.WakeWord
import app.anemo.voice.ui.theme.AnemoTheme
import java.io.IOException
import java.util.concurrent.Executors

/**
 * The phone's settings: Anemo's address and the device token, the wake word and its
 * sensitivity, the sounds, the Bluetooth microphone, the TTS voice and speed. The token
 * field stays empty once one is saved (it is never shown again); typing replaces it.
 */
class SettingsActivity : ComponentActivity() {
    private val io = Executors.newSingleThreadExecutor()
    private lateinit var store: AndroidSettingsStore
    private lateinit var saved: VoiceSettings
    private lateinit var models: ModelFiles
    private var tts: TextToSpeech? = null

    private var form by mutableStateOf(SettingsForm.from(VoiceSettings()))
    private var tokenSaved by mutableStateOf(false)
    private var addressError by mutableStateOf<String?>(null)
    private var modelsPresent by mutableStateOf(false)
    private var downloading by mutableStateOf(false)
    private var voices by mutableStateOf<List<String>>(emptyList())
    private var message by mutableStateOf("")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        store = AndroidSettingsStore(this)
        saved = store.load()
        models = Launcher.modelFiles(this)
        form = SettingsForm.from(saved)
        tokenSaved = saved.token.isNotEmpty()
        showModels()
        setContent {
            AnemoTheme {
                SettingsScreen(
                    view = SettingsView(
                        form = form,
                        tokenSaved = tokenSaved,
                        addressError = addressError,
                        models = SettingsTexts.modelsRow(form.wakeWord, modelsPresent, downloading),
                        voices = voices,
                        message = message,
                    ),
                    onChange = { form = it },
                    onAddressChange = {
                        form = form.copy(address = it)
                        addressError = null
                    },
                    onWordChange = {
                        form = form.copy(wakeWord = it)
                        showModels()
                    },
                    onDownload = ::download,
                    onImport = ::importModel,
                    onSave = ::save,
                    onBack = ::finish,
                )
            }
        }
        loadVoices()
    }

    override fun onDestroy() {
        tts?.shutdown()
        io.shutdown()
        super.onDestroy()
    }

    private fun showModels() {
        modelsPresent = models.present(form.wakeWord)
    }

    private fun loadVoices() {
        tts = TextToSpeech(applicationContext) { status ->
            if (status != TextToSpeech.SUCCESS) return@TextToSpeech
            val names = AndroidSpeaker.voiceNames(tts ?: return@TextToSpeech)
            runOnUiThread {
                voices = names
                form = form.copy(voice = SettingsForm.voiceAfterLoading(saved, names))
            }
        }
    }

    private fun download() {
        val w = form.wakeWord
        message = "Downloading…"
        downloading = true
        io.execute {
            val result = try {
                models.download(w)
                if (w == WakeWord.Custom && !models.present(w)) "Now import your word's .onnx file." else "Downloaded."
            } catch (e: IOException) {
                "Download failed: ${e.message}"
            }
            runOnUiThread {
                message = result
                downloading = false
                showModels()
            }
        }
    }

    private fun importModel(uri: Uri) {
        io.execute {
            val result = try {
                contentResolver.openInputStream(uri)?.use { models.importCustom(it) }
                    ?: throw IOException("could not read the file")
                "Imported. Choose “${WakeWord.Custom.spoken}” and name it above."
            } catch (e: IOException) {
                "Import failed: ${e.message}"
            }
            runOnUiThread {
                message = result
                form = form.copy(wakeWord = WakeWord.Custom)
                showModels()
            }
        }
    }

    private fun save() {
        val next = when (val result = form.toSettings(saved)) {
            is SaveResult.Invalid -> {
                message = result.message
                addressError = result.message
                return
            }
            is SaveResult.Valid -> result.settings
        }
        store.save(next)
        saved = next
        form = form.copy(token = "")
        tokenSaved = next.token.isNotEmpty()
        addressError = null
        showModels()
        if (ListenService.running) {
            // the service reads the settings when it starts: restart it with the new ones
            startService(ListenService.intent(this, ListenService.STOP))
            message = "Saved. Start listening again to use the new settings."
        } else {
            message = "Saved."
        }
    }
}
