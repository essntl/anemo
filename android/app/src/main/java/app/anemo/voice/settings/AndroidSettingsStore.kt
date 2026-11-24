package app.anemo.voice.settings

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * The phone's settings: the token in `EncryptedSharedPreferences` (key in the Android
 * Keystore), everything else in plain preferences. Excluded from backups (see the
 * manifest's backup rules).
 */
class AndroidSettingsStore(context: Context) : SettingsStore {
    private val app = context.applicationContext
    private val plain: SharedPreferences = app.getSharedPreferences("anemo.settings", Context.MODE_PRIVATE)
    private val secure: SharedPreferences by lazy {
        val key = MasterKey.Builder(app).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(
            app,
            "anemo.secure",
            key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    override fun load(): VoiceSettings {
        val d = VoiceSettings()
        return VoiceSettings(
            address = plain.getString(ADDRESS, d.address).orEmpty(),
            token = secure.getString(TOKEN, d.token).orEmpty(),
            wakeWord = WakeWord.of(plain.getString(WAKE_WORD, d.wakeWord.id).orEmpty()),
            customWordName = plain.getString(CUSTOM_NAME, d.customWordName).orEmpty(),
            sensitivity = Sensitivity.entries.firstOrNull { it.name == plain.getString(SENSITIVITY, null) }
                ?: d.sensitivity,
            sounds = plain.getBoolean(SOUNDS, d.sounds),
            bluetoothMic = plain.getBoolean(BLUETOOTH, d.bluetoothMic),
            ttsVoice = plain.getString(TTS_VOICE, d.ttsVoice).orEmpty(),
            ttsSpeed = plain.getFloat(TTS_SPEED, d.ttsSpeed),
            vibrate = plain.getBoolean(VIBRATE, d.vibrate),
            voiceModePhrase = plain.getBoolean(VOICE_MODE_PHRASE, d.voiceModePhrase),
            voiceModeIdleSeconds = VoiceSettings.idleSeconds(plain.getInt(VOICE_MODE_IDLE, d.voiceModeIdleSeconds)),
        )
    }

    override fun save(settings: VoiceSettings) {
        plain.edit()
            .putString(ADDRESS, settings.address.trim())
            .putString(WAKE_WORD, settings.wakeWord.id)
            .putString(CUSTOM_NAME, settings.customWordName.trim())
            .putString(SENSITIVITY, settings.sensitivity.name)
            .putBoolean(SOUNDS, settings.sounds)
            .putBoolean(BLUETOOTH, settings.bluetoothMic)
            .putString(TTS_VOICE, settings.ttsVoice)
            .putFloat(TTS_SPEED, settings.ttsSpeed.coerceIn(0.5f, 2.0f))
            .putBoolean(VIBRATE, settings.vibrate)
            .putBoolean(VOICE_MODE_PHRASE, settings.voiceModePhrase)
            .putInt(VOICE_MODE_IDLE, VoiceSettings.idleSeconds(settings.voiceModeIdleSeconds))
            .apply()
        secure.edit().putString(TOKEN, settings.token.trim()).apply()
    }

    private companion object {
        const val ADDRESS = "address"
        const val TOKEN = "token"
        const val WAKE_WORD = "wake_word"
        const val CUSTOM_NAME = "custom_word_name"
        const val SENSITIVITY = "sensitivity"
        const val SOUNDS = "sounds"
        const val BLUETOOTH = "bluetooth_mic"
        const val TTS_VOICE = "tts_voice"
        const val TTS_SPEED = "tts_speed"
        const val VIBRATE = "vibrate"
        const val VOICE_MODE_PHRASE = "voice_mode_phrase"
        const val VOICE_MODE_IDLE = "voice_mode_idle_seconds"
    }
}
