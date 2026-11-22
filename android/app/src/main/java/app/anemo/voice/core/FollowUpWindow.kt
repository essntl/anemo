package app.anemo.voice.core

/**
 * Within [windowMillis] of an answer, a new request continues that answer's chat
 * (its `conversation_id` is sent); after that it starts a new turn.
 */
class FollowUpWindow(private val clock: Clock, private val windowMillis: Long = FIVE_MINUTES) {
    private var conversationId: String? = null
    private var answeredAt = 0L

    fun answered(conversationId: String) {
        this.conversationId = conversationId
        answeredAt = clock.nowMillis()
    }

    /** The chat a request made now continues, or null for a new one. */
    fun conversationForNewRequest(): String? {
        val id = conversationId ?: return null
        return if (clock.nowMillis() - answeredAt <= windowMillis) id else null
    }

    companion object {
        const val FIVE_MINUTES = 5 * 60 * 1000L
    }
}
