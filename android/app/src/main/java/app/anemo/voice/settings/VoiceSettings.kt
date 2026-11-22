package app.anemo.voice.settings

import app.anemo.voice.net.Address

/** How readily the wake word fires: the openWakeWord score it needs. */
enum class Sensitivity(val label: String, val threshold: Float) {
    Low("Low (fewer false wakes)", 0.7f),
    Medium("Medium", 0.5f),
    High("High (hears it more easily)", 0.3f),
}

/** The wake words the app knows. Pre-trained ones are downloaded; [Custom] is imported. */
enum class WakeWord(val id: String, val spoken: String, val file: String) {
    HeyJarvis("hey_jarvis", "Hey Jarvis", "hey_jarvis_v0.1.onnx"),
    Alexa("alexa", "Alexa", "alexa_v0.1.onnx"),
    HeyMycroft("hey_mycroft", "Hey Mycroft", "hey_mycroft_v0.1.onnx"),
    Custom("custom", "your own word", "custom.onnx"),
    ;

    companion object {
        fun of(id: String): WakeWord = entries.firstOrNull { it.id == id } ?: HeyJarvis
    }
}

/** Everything the phone stores (Anemo's own voice settings are on the server). */
data class VoiceSettings(
    val address: String = "",
    val token: String = "",
    val wakeWord: WakeWord = WakeWord.HeyJarvis,
    /** What the user calls their custom word, for the notification. */
    val customWordName: String = "",
    val sensitivity: Sensitivity = Sensitivity.Medium,
    val sounds: Boolean = true,
    val bluetoothMic: Boolean = true,
    /** A `TextToSpeech` voice name; empty for the voice set in Android's settings. */
    val ttsVoice: String = "",
    /** Speech rate, 0.5 to 2.0 (1.0 is normal). */
    val ttsSpeed: Float = 1.0f,
) {
    val wakeWordName: String
        get() = if (wakeWord == WakeWord.Custom && customWordName.isNotBlank()) customWordName.trim() else wakeWord.spoken

    /** The `toString` of a data class would print the token: never. */
    override fun toString(): String = "VoiceSettings(address=$address, wakeWord=${wakeWord.id}, token=…)"
}

interface SettingsStore {
    fun load(): VoiceSettings
    fun save(settings: VoiceSettings)
}

/** Why listening can't start, in the words the app shows. Null when it can. */
enum class Problem(val message: String) {
    NoAddress("Enter Anemo's address in Settings."),
    BadAddress("The address must be an https:// address, the one you open Anemo with."),
    NoToken("Paste a token from Anemo's Settings → Devices."),
    NoMicrophone("Allow the microphone, or Anemo Voice can't hear the wake word."),
    NoNotifications("Allow notifications: Anemo Voice only listens while its notification shows."),
    NoWakeWordModel("Download the wake word models (or import your own) in Settings."),
}

object Readiness {
    fun check(
        settings: VoiceSettings,
        hasMicrophone: Boolean,
        notificationsShown: Boolean,
        modelsPresent: Boolean,
    ): Problem? = when {
        settings.address.isBlank() -> Problem.NoAddress
        Address.parse(settings.address) == null -> Problem.BadAddress
        settings.token.isBlank() -> Problem.NoToken
        !hasMicrophone -> Problem.NoMicrophone
        !notificationsShown -> Problem.NoNotifications
        !modelsPresent -> Problem.NoWakeWordModel
        else -> null
    }
}
