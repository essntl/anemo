package app.anemo.voice.core

/** Everything the phone says by itself (the answers of runs come from the server). */
object Phrases {
    const val MAX_PLAN_STEPS = 6

    const val NEEDS_TAP = "That one needs a tap."
    const val USE_NOTIFICATION = "Please answer on the notification."
    const val NO_TRANSCRIPTION_MODEL =
        "Anemo has no speech-to-text model yet. Choose one for Transcription in Settings, Providers and Models."
    const val REFUSED = "Anemo did not accept the recording."
    const val UNAUTHORIZED = "Anemo refused the token. Check it in the app's settings."
    const val UNREACHABLE = "I could not reach Anemo."

    /** Only the wake word was heard (the server says the same when it hears nothing). */
    const val NOT_HEARD = "Sorry, I didn't catch that."

    /** Said instead of asking when a question or approval has no text to read out. */
    const val NOTHING_TO_READ = "Anemo is waiting for your answer. $USE_NOTIFICATION"

    /** The server's own sentence when it sent one, else the phone's. */
    fun refused(error: ServerError, fallback: String = REFUSED): String = when {
        !error.message.isNullOrBlank() -> error.message.trim()
        error.code == "no_transcription_model" -> NO_TRANSCRIPTION_MODEL
        else -> fallback
    }

    /** True when there is nothing meaningful to read out before listening for a reply. */
    fun nothingToRead(approval: Approval): Boolean = when (approval.kind) {
        Approval.Kind.Action -> approval.summary.isBlank()
        Approval.Kind.Question -> approval.question.isNullOrBlank() && approval.summary.isBlank()
        Approval.Kind.Plan -> approval.steps.none { it.isNotBlank() } && approval.summary.isBlank()
    }

    /** What is said to ask for an approval, a question or a plan review by voice. */
    fun ask(approval: Approval): String = when (approval.kind) {
        Approval.Kind.Action -> "${sentence(approval.summary)} Allow?"
        Approval.Kind.Question -> question(approval)
        Approval.Kind.Plan -> plan(approval.steps)
    }

    /** A dangerous action is never decided by voice: say what it is and why not. */
    fun dangerous(approval: Approval): String = "${sentence(approval.summary)} $NEEDS_TAP"

    fun question(approval: Approval): String {
        val q = sentence(approval.question?.takeIf { it.isNotBlank() } ?: approval.summary)
        val options = approval.options.map { it.trim() }.filter { it.isNotEmpty() }
        return if (options.isEmpty()) q else "$q The options are: ${orList(options)}."
    }

    fun plan(steps: List<String>): String {
        val shown = steps.take(MAX_PLAN_STEPS)
        val parts = mutableListOf("Here is the plan.")
        shown.forEachIndexed { i, s -> parts += "Step ${i + 1}: ${sentence(s)}" }
        val rest = steps.size - shown.size
        if (rest > 0) parts += "and $rest more."
        parts += "Go ahead?"
        return parts.joinToString(" ")
    }

    private fun orList(items: List<String>): String = when (items.size) {
        1 -> items[0]
        2 -> "${items[0]} or ${items[1]}"
        else -> items.dropLast(1).joinToString(", ") + ", or " + items.last()
    }

    /** Ends the text with a full stop unless it already ends a sentence. */
    private fun sentence(text: String): String {
        val t = text.trim()
        if (t.isEmpty()) return t
        return if (t.last() in ".?!") t else "$t."
    }
}
