package app.anemo.voice.service

import android.util.Log
import app.anemo.voice.core.VoiceModeCause
import java.util.Locale

/**
 * The only place the app logs (tag `AnemoVoice`: `adb logcat -s AnemoVoice`). Each
 * function takes numbers and fixed values only, never text, so no token, transcript or
 * answer can reach the log (PrivacyRulesTest checks both).
 */
object Logcat {
    private const val TAG = "AnemoVoice"

    fun wakeWord(score: Float) {
        Log.i(TAG, String.format(Locale.ROOT, "wake word heard score=%.2f", score))
    }

    fun voiceMode(on: Boolean, cause: VoiceModeCause) {
        Log.i(TAG, "voice mode ${if (on) "on" else "off"} cause=${cause.wire}")
    }
}
