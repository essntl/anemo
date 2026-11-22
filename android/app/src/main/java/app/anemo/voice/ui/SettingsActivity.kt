package app.anemo.voice.ui

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.text.InputType
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.Spinner
import android.widget.Switch
import android.widget.TextView
import app.anemo.voice.audio.AndroidSpeaker
import app.anemo.voice.ml.ModelFiles
import app.anemo.voice.service.Launcher
import app.anemo.voice.service.ListenService
import app.anemo.voice.settings.AndroidSettingsStore
import app.anemo.voice.settings.Sensitivity
import app.anemo.voice.settings.VoiceSettings
import app.anemo.voice.settings.WakeWord
import app.anemo.voice.net.Address
import java.io.IOException
import java.util.concurrent.Executors

/**
 * The phone's settings: Anemo's address and the device token, the wake word and its
 * sensitivity, the sounds, the Bluetooth microphone, the TTS voice and speed. The token
 * field stays empty once one is saved (it is never shown again); typing replaces it.
 */
class SettingsActivity : Activity() {
    private val io = Executors.newSingleThreadExecutor()
    private lateinit var store: AndroidSettingsStore
    private lateinit var saved: VoiceSettings
    private lateinit var models: ModelFiles

    private lateinit var address: EditText
    private lateinit var token: EditText
    private lateinit var wakeWord: Spinner
    private lateinit var customName: EditText
    private lateinit var sensitivity: Spinner
    private lateinit var sounds: Switch
    private lateinit var bluetooth: Switch
    private lateinit var voice: Spinner
    private lateinit var speed: SeekBar
    private lateinit var speedLabel: TextView
    private lateinit var modelState: TextView
    private lateinit var message: TextView
    private var voices: List<String> = emptyList()
    private var tts: TextToSpeech? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = AndroidSettingsStore(this)
        saved = store.load()
        models = Launcher.modelFiles(this)

        address = EditText(this).apply {
            hint = "https://anemo.example.com"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setText(saved.address)
        }
        token = EditText(this).apply {
            hint = if (saved.token.isEmpty()) "anemo_…" else "A token is saved (type to replace it)"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        wakeWord = spinner(WakeWord.entries.map { it.spoken }, WakeWord.entries.indexOf(saved.wakeWord))
        customName = EditText(this).apply {
            hint = "What you call your own word (e.g. Hey Anemo)"
            setText(saved.customWordName)
        }
        sensitivity = spinner(Sensitivity.entries.map { it.label }, Sensitivity.entries.indexOf(saved.sensitivity))
        sounds = Switch(this).apply {
            text = "Start and stop sounds"
            isChecked = saved.sounds
        }
        bluetooth = Switch(this).apply {
            text = "Use a Bluetooth headset's microphone when one is connected"
            isChecked = saved.bluetoothMic
        }
        voice = spinner(listOf("Android's voice"), 0)
        speedLabel = label("")
        speed = SeekBar(this).apply {
            max = 15 // 0.5 … 2.0 in steps of 0.1
            progress = ((saved.ttsSpeed - 0.5f) * 10).toInt().coerceIn(0, 15)
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(s: SeekBar, p: Int, fromUser: Boolean) = showSpeed()
                override fun onStartTrackingTouch(s: SeekBar) = Unit
                override fun onStopTrackingTouch(s: SeekBar) = Unit
            })
        }
        showSpeed()
        modelState = label("")
        message = label("")

        val form = column().apply {
            addView(heading("Anemo"))
            addView(label("Address (the one you open Anemo with)"))
            addView(address)
            addView(label("Token (Settings → Devices in Anemo, a phone device)"))
            addView(token)
            addView(heading("Wake word"))
            addView(wakeWord)
            addView(customName)
            addView(label("Sensitivity"))
            addView(sensitivity)
            addView(modelState)
            addView(button("Download the wake word models") { download() })
            addView(button("Import your own word (.onnx)") { pickCustomModel() })
            addView(label(LICENCE_NOTE, 12f))
            addView(heading("Sound"))
            addView(sounds)
            addView(bluetooth)
            addView(label("Voice"))
            addView(voice)
            addView(speedLabel)
            addView(speed)
            addView(message)
            addView(button("Save") { save() })
        }
        setContentView(ScrollView(this).apply {
            addView(form)
            clipToPadding = false
            padForSystemBars()
        })
        wakeWord.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: AdapterView<*>?, v: android.view.View?, pos: Int, id: Long) = showModels()
            override fun onNothingSelected(p: AdapterView<*>?) = Unit
        }
        showModels()
        loadVoices()
    }

    override fun onDestroy() {
        tts?.shutdown()
        io.shutdown()
        super.onDestroy()
    }

    private fun spinner(items: List<String>, selected: Int) = Spinner(this).apply {
        adapter = ArrayAdapter(this@SettingsActivity, android.R.layout.simple_spinner_dropdown_item, items)
        setSelection(selected.coerceAtLeast(0))
    }

    private fun showSpeed() {
        speedLabel.text = "Speed: %.1f×".format(0.5f + speed.progress / 10f)
    }

    private fun selectedWord() = WakeWord.entries[wakeWord.selectedItemPosition]

    private fun showModels() {
        val w = selectedWord()
        modelState.text = if (models.present(w)) "Models for ${w.spoken}: ready" else "Models for ${w.spoken}: not downloaded yet"
    }

    private fun loadVoices() {
        tts = TextToSpeech(applicationContext) { status ->
            if (status != TextToSpeech.SUCCESS) return@TextToSpeech
            val names = AndroidSpeaker.voiceNames(tts ?: return@TextToSpeech)
            runOnUiThread {
                voices = names
                voice.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, listOf("Android's voice") + names)
                voice.setSelection(names.indexOf(saved.ttsVoice) + 1)
            }
        }
    }

    private fun download() {
        val w = selectedWord()
        message.text = "Downloading…"
        io.execute {
            val result = try {
                models.download(w)
                if (w == WakeWord.Custom && !models.present(w)) "Now import your word's .onnx file." else "Downloaded."
            } catch (e: IOException) {
                "Download failed: ${e.message}"
            }
            runOnUiThread {
                message.text = result
                showModels()
            }
        }
    }

    private fun pickCustomModel() {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
        startActivityForResult(intent, PICK_MODEL)
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        val uri = data?.data
        if (requestCode != PICK_MODEL || resultCode != RESULT_OK || uri == null) return
        io.execute {
            val result = try {
                contentResolver.openInputStream(uri)?.use { models.importCustom(it) }
                    ?: throw IOException("could not read the file")
                "Imported. Choose “${WakeWord.Custom.spoken}” and name it above."
            } catch (e: IOException) {
                "Import failed: ${e.message}"
            }
            runOnUiThread {
                message.text = result
                wakeWord.setSelection(WakeWord.entries.indexOf(WakeWord.Custom))
                showModels()
            }
        }
    }

    private fun save() {
        val typedAddress = address.text.toString().trim()
        if (typedAddress.isNotEmpty() && Address.parse(typedAddress) == null) {
            message.text = "The address must be an https:// address."
            return
        }
        val next = saved.copy(
            address = typedAddress,
            token = token.text.toString().trim().ifEmpty { saved.token },
            wakeWord = selectedWord(),
            customWordName = customName.text.toString(),
            sensitivity = Sensitivity.entries[sensitivity.selectedItemPosition],
            sounds = sounds.isChecked,
            bluetoothMic = bluetooth.isChecked,
            ttsVoice = voices.getOrNull(voice.selectedItemPosition - 1).orEmpty(),
            ttsSpeed = 0.5f + speed.progress / 10f,
        )
        store.save(next)
        saved = next
        token.setText("")
        token.hint = "A token is saved (type to replace it)"
        showModels()
        if (ListenService.running) {
            // the service reads the settings when it starts: restart it with the new ones
            startService(ListenService.intent(this, ListenService.STOP))
            message.text = "Saved. Start listening again to use the new settings."
        } else {
            message.text = "Saved."
        }
    }

    companion object {
        private const val PICK_MODEL = 2
        private const val LICENCE_NOTE =
            "The wake word models come from openWakeWord's release on GitHub. Its pre-trained words are " +
                "licensed CC BY-NC-SA 4.0 (personal, non-commercial use), so they are downloaded here, not " +
                "shipped with the app. A word you train yourself with openWakeWord's notebook can be imported."
    }
}
