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
    context: Context,
    private val voiceName: String,
    private val speed: Float,
    private val post: (Runnable) -> Unit,
) : Speaker {
    private val audio = context.getSystemService(AudioManager::class.java)
    private val attributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANT)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()
    private val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
        .setAudioAttributes(attributes)
        .build()

    private val lock = Any()
    private var ready: Boolean? = null // null while the engine starts
    private var nextId = 0
    private var pending: Pair<String, (Boolean) -> Unit>? = null
    private val callbacks = HashMap<String, (Boolean) -> Unit>()

    private val tts: TextToSpeech = TextToSpeech(context.applicationContext) { status ->
        val waiting = synchronized(lock) {
            ready = status == TextToSpeech.SUCCESS
            pending.also { pending = null }
        }
        if (status == TextToSpeech.SUCCESS) configure()
        waiting?.let { (text, done) -> speak(text, done) }
    }

    init {
        tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String) = Unit
            override fun onDone(utteranceId: String) = finish(utteranceId, true)

            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String) = finish(utteranceId, false)
            override fun onError(utteranceId: String, errorCode: Int) = finish(utteranceId, false)
            override fun onStop(utteranceId: String, interrupted: Boolean) = finish(utteranceId, false)
        })
    }

    private fun configure() {
        tts.setAudioAttributes(attributes)
        tts.setSpeechRate(speed)
        if (voiceName.isNotEmpty()) {
            tts.voices?.firstOrNull { it.name == voiceName }?.let { tts.voice = it }
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
                    post { onDone(false) }
                    return
                }
                true -> "anemo-${nextId++}".also { callbacks[it] = onDone }
            }
        }
        audio.requestAudioFocus(focus)
        if (tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, id) != TextToSpeech.SUCCESS) finish(id, false)
    }

    override fun stop() {
        val waiting = synchronized(lock) { pending.also { pending = null } }
        waiting?.second?.let { cb -> post { cb(false) } }
        tts.stop()
        audio.abandonAudioFocusRequest(focus)
    }

    private fun finish(id: String, completed: Boolean) {
        val cb = synchronized(lock) { callbacks.remove(id) } ?: return
        audio.abandonAudioFocusRequest(focus)
        post { cb(completed) }
    }

    fun shutdown() {
        tts.stop()
        tts.shutdown()
        audio.abandonAudioFocusRequest(focus)
    }

    companion object {
        /** The voices Android's speech engine offers, for the settings screen. */
        fun voiceNames(tts: TextToSpeech): List<String> =
            tts.voices.orEmpty().filter { !it.isNetworkConnectionRequired }.map { it.name }.sorted()
    }
}
