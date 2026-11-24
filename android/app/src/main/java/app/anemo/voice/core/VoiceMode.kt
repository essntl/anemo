package app.anemo.voice.core

/**
 * Why voice mode went on or off. [wire] is the `cause` of the `voice.mode` message
 * (docs/device-contracts.md §2), which the server writes to its audit log.
 */
enum class VoiceModeCause(val wire: String, val label: String) {
    Tile("tile", "from the tile"),
    Notification("notification", "from the notification"),
    Phrase("phrase", "you said start voice mode"),
    StopPhrase("stop_phrase", "you said stop"),
    Timeout("timeout", "nobody spoke"),
    VoiceStop("voice_stop", "Anemo ended it"),
    ServiceStopped("service_stopped", "listening paused or stopped"),
}

/**
 * Voice mode: after each answer the microphone opens again, without the wake word, until
 * it is turned off. Pure bookkeeping, no audio; [VoiceController] asks it what to do.
 *
 * - Only the user turns it on ([turnOn]: the tile, the notification, "start voice mode").
 *   Nothing from the server can: `voice.stop` only ever ends it.
 * - Each time it goes on is a new [session]. Something that belongs to an older session
 *   (an answer, a transcript) never opens the microphone.
 * - The microphone opens again only after the answer of the run the last request of this
 *   session started ([awaited]). Answers of other runs are only spoken.
 */
class VoiceMode {
    /** What to do once an answer has been spoken. */
    enum class After { Nothing, Reopen, End }

    var on = false
        private set

    /** Counts up each time voice mode goes on. 0: it never did. */
    var session = 0
        private set

    private var requests = 0
    private var awaited: String? = null
    private val ending = LinkedHashSet<String>()

    /** False when it was already on. */
    fun turnOn(): Boolean {
        if (on) return false
        on = true
        session++
        forget()
        return true
    }

    /** False when it was already off. */
    fun turnOff(): Boolean {
        if (!on) return false
        on = false
        forget()
        return true
    }

    /**
     * A request is being sent in voice mode. True when it should stay in the chat of the
     * previous one (`keep_chat`): every request but the first of a session.
     */
    fun requestSent(): Boolean = requests++ > 0

    /** The run a request of [inSession] started: its answer opens the microphone again. */
    fun started(runId: String, inSession: Int) {
        if (on && inSession == session) awaited = runId
    }

    /** The agent called `voice_stop` in [runId]: end voice mode after its answer. */
    fun stopAfter(runId: String) {
        if (!on) return
        ending += runId
        if (ending.size > REMEMBERED) ending.remove(ending.first())
    }

    /** The answer of [runId] arrived: what to do once it has been spoken. */
    fun answered(runId: String): After {
        if (!on || runId != awaited) return After.Nothing
        awaited = null
        return if (runId in ending) After.End else After.Reopen
    }

    /** Whether something of [inSession] may still open the microphone. */
    fun current(inSession: Int): Boolean = on && inSession == session

    private fun forget() {
        requests = 0
        awaited = null
        ending.clear()
    }

    private companion object {
        const val REMEMBERED = 20
    }
}
