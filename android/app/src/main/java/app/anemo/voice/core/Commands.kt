package app.anemo.voice.core

/** What the user can say to switch voice mode (docs/specs/07-voice-mode-android.md). */
enum class Command { StartVoiceMode, StopVoiceMode }

/**
 * Voice-mode commands, matched on the phone, on what the transcription model heard, by
 * plain code: never by a language model, and never on anything a run wrote.
 *
 * The whole utterance must be the command. Before comparing, the text is made lower
 * case, apostrophes are dropped and everything that isn't a letter or digit becomes a
 * space; the wake word at the start and filler words ("please", "ok", …) anywhere are
 * dropped. A phrase of three or more words still matches with one misheard word, if that
 * word is close to the right one ("start voice mood"); a shorter phrase must match exactly.
 */
object Commands {
    val START_PHRASES = listOf(
        "start voice mode", "turn on voice mode", "voice mode on", "enable voice mode", "begin voice mode",
    )
    val STOP_PHRASES = listOf(
        "stop", "stop voice mode", "end voice mode", "exit voice mode", "turn off voice mode", "voice mode off",
    )
    private val FILLERS = setOf("please", "ok", "okay", "um", "uh", "the", "now", "anemo")
    private val WORD = Regex("[\\p{L}\\p{N}']+")

    /**
     * The command [heard] is, or null when it is an ordinary request.
     *
     * [voiceModeOn]: "stop" and the other stop phrases only count while voice mode is on.
     * [startPhrase]: the setting "Say “start voice mode” to turn it on"; while voice mode
     * is on, "start voice mode" always counts (it opens the microphone again).
     */
    fun match(heard: String, wakeWord: String, voiceModeOn: Boolean, startPhrase: Boolean): Command? {
        val said = withoutWakeWord(words(heard), words(wakeWord)).filter { it !in FILLERS }
        if (said.isEmpty()) return null
        // The closest phrase of either kind, so "stop voice mode" is never taken for
        // "start voice mode" with one word misheard, even while only starting counts.
        val scored = (START_PHRASES.map { Command.StartVoiceMode to it } + STOP_PHRASES.map { Command.StopVoiceMode to it })
            .mapNotNull { (command, phrase) -> distance(said, phrase.split(" "))?.let { command to it } }
        val best = scored.minOfOrNull { it.second } ?: return null
        val winners = scored.filter { it.second == best }.map { it.first }.toSet()
        val command = winners.singleOrNull() ?: return null // a tie between start and stop
        return when (command) {
            Command.StartVoiceMode -> command.takeIf { voiceModeOn || startPhrase }
            Command.StopVoiceMode -> command.takeIf { voiceModeOn }
        }
    }

    /**
     * [heard] without the wake word at its start, as heard otherwise (the server cleans
     * it up). The recording starts a little before the wake word was detected, so the
     * transcript often begins with it, or with its last part ("…vis, what's on today").
     */
    fun request(heard: String, wakeWord: String): String {
        val found = WORD.findAll(heard).toList()
        val drop = found.size - withoutWakeWord(found.map { normal(it.value) }, words(wakeWord)).size
        if (drop == 0) return heard.trim()
        val rest = heard.substring(found[drop - 1].range.last + 1)
        return rest.trimStart { !it.isLetterOrDigit() }.trim()
    }

    /** Lower case words: apostrophes dropped, anything else that isn't a letter or digit splits. */
    fun words(text: String): List<String> =
        text.lowercase().replace("'", "").replace("’", "").split(Regex("[^\\p{L}\\p{N}]+")).filter { it.isNotEmpty() }

    private fun normal(word: String): String = words(word).joinToString("")

    /** Drops leading words that are the wake word, a near miss of it, or the end of its last word. */
    private fun withoutWakeWord(said: List<String>, wake: List<String>): List<String> {
        if (wake.isEmpty()) return said
        var i = 0
        while (i < said.size && isWakeWord(said[i], wake, first = i == 0)) i++
        return said.drop(i)
    }

    private fun isWakeWord(word: String, wake: List<String>, first: Boolean): Boolean =
        wake.any { w -> word == w || (w.length >= 5 && editDistance(word, w) <= 1) } ||
            (first && word.length >= 3 && wake.last().length > word.length && wake.last().endsWith(word))

    /**
     * How far [said] is from [phrase] in letters, or null when it doesn't match: the same
     * number of words, and at most one of them different (phrases of three words or more),
     * that one close to the right word.
     */
    private fun distance(said: List<String>, phrase: List<String>): Int? {
        if (said.size != phrase.size) return null
        val different = said.indices.filter { said[it] != phrase[it] }
        if (different.isEmpty()) return 0
        if (phrase.size < 3 || different.size > 1) return null
        val i = different.single()
        val d = editDistance(said[i], phrase[i])
        return d.takeIf { it <= maxOf(1, maxOf(said[i].length, phrase[i].length) / 2) }
    }

    /** Levenshtein distance: the fewest letters to add, remove or change. */
    fun editDistance(a: String, b: String): Int {
        var previous = IntArray(b.length + 1) { it }
        for (i in 1..a.length) {
            val current = IntArray(b.length + 1)
            current[0] = i
            for (j in 1..b.length) {
                val change = if (a[i - 1] == b[j - 1]) 0 else 1
                current[j] = minOf(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + change)
            }
            previous = current
        }
        return previous[b.length]
    }
}
