package app.anemo.voice.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import app.anemo.voice.core.Speaker

/**
 * Speech out with Android's `TextToSpeech` (the voice chosen in the app, else Android's
 * own). Takes transient audio focus while it speaks, so music ducks, and tells the voice
 * loop through `UtteranceProgressListener` when it is done (then it may listen for a reply).
 * [post] moves the callbacks onto the voice thread.
 */
class AndroidSpeaker(
    private val context: Context,
    private val voiceName: String,
    private val speed: Float,
    private val post: (Runnable) -> Unit,
    /** Android's speech engine could not be started: nothing will be spoken. */
    private val onUnavailable: () -> Unit = {},
    /** It started after all (another engine was chosen, or it was only slow). */
    private val onAvailable: () -> Unit = {},
    private val now: () -> Long = { android.os.SystemClock.elapsedRealtime() },
) : Speaker {
    private val audio = context.getSystemService(AudioManager::class.java)
    private val attributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANT)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()
    private val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
        .setAudioAttributes(attributes)
        .setOnAudioFocusChangeListener { change ->
            // a call or another app took the audio: stop speaking (the loop moves on)
            if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) tts?.stop()
        }
        .build()

    private val lock = Any()
    private var ready: Boolean? = null // null while the engine starts
    private var nextId = 0
    private var pending: Pair<String, (Boolean) -> Unit>? = null
    private val callbacks = HashMap<String, (Boolean) -> Unit>()

    private var tts: TextToSpeech? = null
    private var startedAt = 0L
    private var failedBefore = false

    init {
        start()
    }

    /** Bind Android's speech engine (the one chosen in the phone's settings right now). */
    private fun start() {
        startedAt = now()
        synchronized(lock) { ready = null }
        var engine: TextToSpeech? = null
        engine = TextToSpeech(context.applicationContext) { status ->
            // On some phones a failure is reported from inside the constructor.
            runCatching { post { started(engine, status == TextToSpeech.SUCCESS) } } // stopped meanwhile: nothing to tell
        }
        tts = engine
    }

    private fun started(engine: TextToSpeech?, ok: Boolean) {
        if (engine == null || engine !== tts) return // an older attempt
        val waiting = synchronized(lock) {
            ready = ok
            pending.also { pending = null }
        }
        if (ok) {
            configure(engine)
            if (failedBefore) onAvailable()
            failedBefore = false
        } else {
            failedBefore = true
            runCatching { engine.shutdown() }
            onUnavailable()
        }
        waiting?.let { (text, done) -> if (ok) speak(text, done) else post { done(false) } }
    }

    private fun configure(engine: TextToSpeech) {
        engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String) = Unit
            override fun onDone(utteranceId: String) = finish(utteranceId, true)

            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String) = finish(utteranceId, false)
            override fun onError(utteranceId: String, errorCode: Int) = finish(utteranceId, false)
            override fun onStop(utteranceId: String, interrupted: Boolean) = finish(utteranceId, false)
        })
        engine.setAudioAttributes(attributes)
        engine.setSpeechRate(speed)
        if (voiceName.isNotEmpty()) {
            engine.voices?.firstOrNull { it.name == voiceName }?.let { engine.voice = it }
        }
    }

    override fun speak(text: String, onDone: (completed: Boolean) -> Unit) {
        val id = synchronized(lock) {
            when (ready) {
                null -> {
                    pending?.second?.let { cb -> post { cb(false) } }
                    pending = text to onDone
                    return
                }
                false -> {
                    // The engine didn't start. Try again for this answer (the user may
                    // have chosen another engine since), but not more than every few seconds.
                    if (now() - startedAt < RETRY_AFTER_MS) {
                        post { onDone(false) }
                        return
                    }
                    pending = text to onDone
                    post { start() }
                    return
                }
                true -> "anemo-${nextId++}".also { callbacks[it] = onDone }
            }
        }
        if (audio.requestAudioFocus(focus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            finish(id, false) // in a call, for example: don't talk over it
            return
        }
        if (tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, id) != TextToSpeech.SUCCESS) finish(id, false)
    }

    override fun stop() {
        val waiting = synchronized(lock) { pending.also { pending = null } }
        waiting?.second?.let { cb -> post { cb(false) } }
        tts?.stop()
        audio.abandonAudioFocusRequest(focus)
    }

    private fun finish(id: String, completed: Boolean) {
        val cb = synchronized(lock) { callbacks.remove(id) } ?: return
        audio.abandonAudioFocusRequest(focus)
        post { cb(completed) }
    }

    fun shutdown() {
        runCatching { tts?.stop() }
        runCatching { tts?.shutdown() }
        audio.abandonAudioFocusRequest(focus)
    }

    companion object {
        private const val RETRY_AFTER_MS = 5_000L

        /** The voices Android's speech engine offers, for the settings screen. */
        fun voiceNames(tts: TextToSpeech): List<String> =
            tts.voices.orEmpty().filter { !it.isNetworkConnectionRequired }.map { it.name }.sorted()
    }
}
