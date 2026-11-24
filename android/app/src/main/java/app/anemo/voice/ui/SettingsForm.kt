package app.anemo.voice.ui

import app.anemo.voice.net.Address
import app.anemo.voice.settings.Sensitivity
import app.anemo.voice.settings.VoiceSettings
import app.anemo.voice.settings.WakeWord

/**
 * What the settings screen's controls hold. [token] is what was typed (the saved token is
 * never shown); [voice] is a `TextToSpeech` voice name, empty for Android's voice;
 * [speedStep] is 0..15 for 0.5× … 2.0×.
 */
data class SettingsForm(
    val address: String,
    val token: String,
    val wakeWord: WakeWord,
    val customWordName: String,
    val sensitivity: Sensitivity,
    val sounds: Boolean,
    val bluetoothMic: Boolean,
    val voice: String,
    val speedStep: Int,
    val vibrate: Boolean = true,
    val voiceModePhrase: Boolean = true,
    /** An index into [VoiceSettings.IDLE_CHOICES]. */
    val idleStep: Int = 1,
) {
    /** The token must not reach a log through `toString`. */
    override fun toString(): String = "SettingsForm(address=$address, wakeWord=${wakeWord.id}, token=…)"

    /** The settings to save over [saved], or why they can't be saved. */
    fun toSettings(saved: VoiceSettings): SaveResult {
        val typedAddress = address.trim()
        if (typedAddress.isNotEmpty() && Address.parse(typedAddress) == null) {
            return SaveResult.Invalid(BAD_ADDRESS)
        }
        return SaveResult.Valid(
            saved.copy(
                address = typedAddress,
                token = token.trim().ifEmpty { saved.token },
                wakeWord = wakeWord,
                customWordName = customWordName,
                sensitivity = sensitivity,
                sounds = sounds,
                bluetoothMic = bluetoothMic,
                ttsVoice = voice,
                ttsSpeed = speedOf(speedStep),
                vibrate = vibrate,
                voiceModePhrase = voiceModePhrase,
                voiceModeIdleSeconds = VoiceSettings.IDLE_CHOICES[idleStep.coerceIn(VoiceSettings.IDLE_CHOICES.indices)],
            ),
        )
    }

    companion object {
        const val BAD_ADDRESS = "The address must be an https:// address."
        const val MAX_SPEED_STEP = 15

        /**
         * The form for [saved]. The voice starts as Android's own until the list of
         * voices is loaded ([voiceAfterLoading]).
         */
        fun from(saved: VoiceSettings) = SettingsForm(
            address = saved.address,
            token = "",
            wakeWord = saved.wakeWord,
            customWordName = saved.customWordName,
            sensitivity = saved.sensitivity,
            sounds = saved.sounds,
            bluetoothMic = saved.bluetoothMic,
            voice = "",
            speedStep = speedStep(saved.ttsSpeed),
            vibrate = saved.vibrate,
            voiceModePhrase = saved.voiceModePhrase,
            idleStep = VoiceSettings.IDLE_CHOICES.indexOf(VoiceSettings.idleSeconds(saved.voiceModeIdleSeconds)),
        )

        /** The saved voice once the phone's voices are known; Android's voice when it is gone. */
        fun voiceAfterLoading(saved: VoiceSettings, voices: List<String>): String =
            if (saved.ttsVoice in voices) saved.ttsVoice else ""

        fun speedStep(speed: Float): Int = ((speed - 0.5f) * 10).toInt().coerceIn(0, MAX_SPEED_STEP)

        fun speedOf(step: Int): Float = 0.5f + step / 10f

        fun speedLabel(step: Int): String = "%.1f×".format(speedOf(step))
    }
}

sealed interface SaveResult {
    data class Valid(val settings: VoiceSettings) : SaveResult
    data class Invalid(val message: String) : SaveResult
}

/** The models row of the settings: ready, missing (with a Download button) or downloading. */
data class ModelsRow(val title: String, val hint: String, val tone: Tone, val canDownload: Boolean)

object SettingsTexts {
    /** "Your own word" in the list, where the sentence form is "your own word". */
    fun wordLabel(word: WakeWord): String = word.spoken.replaceFirstChar { it.uppercase() }

    fun modelsRow(word: WakeWord, present: Boolean, downloading: Boolean): ModelsRow = when {
        downloading -> ModelsRow("Models for ${word.spoken}", "Downloading…", Tone.Warn, canDownload = false)
        present -> ModelsRow("Models for ${word.spoken}: ready", "Downloaded to this phone", Tone.Ok, canDownload = false)
        else -> ModelsRow("Models for ${word.spoken}", "Models not downloaded yet", Tone.Warn, canDownload = true)
    }

    /** How a message of the save bar is coloured. */
    fun messageTone(text: String): Tone = when {
        text.startsWith("Saved") || text == "Downloaded." || text.startsWith("Imported") -> Tone.Ok
        text.contains("failed") || text == SettingsForm.BAD_ADDRESS -> Tone.Err
        else -> Tone.Neutral
    }
}
