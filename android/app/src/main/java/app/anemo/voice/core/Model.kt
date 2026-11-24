package app.anemo.voice.core

/** What a run waits for (device-contracts.md §2, `approval.requested`). */
data class Approval(
    val id: String,
    val runId: String,
    val kind: Kind,
    val summary: String,
    /** `safe`, `normal`, `dangerous`, …; null when the server sent none. */
    val risk: String?,
    val question: String? = null,
    val options: List<String> = emptyList(),
    val steps: List<String> = emptyList(),
) {
    enum class Kind { Action, Question, Plan }

    /** Never decided by voice. A missing risk counts as dangerous (fail closed). */
    val dangerous: Boolean get() = risk == "dangerous" || (kind == Kind.Action && risk.isNullOrBlank()) || (kind == Kind.Action && risk.isNullOrBlank())
}

/** Events a phone gets on its WebSocket. Unknown events and kinds never become one. */
sealed interface DeviceEvent {
    data class RunStatus(val runId: String, val status: String) : DeviceEvent
    data class ApprovalRequested(val approval: Approval) : DeviceEvent
    data class ApprovalDecided(val approvalId: String, val decision: String) : DeviceEvent
    data class VoiceSay(
        val runId: String,
        val conversationId: String?,
        val text: String,
        val more: Boolean,
    ) : DeviceEvent

    /** The agent ended voice mode in a run this phone started (`voice_stop`). */
    data class VoiceStop(val runId: String, val conversationId: String?) : DeviceEvent
}

/**
 * An answer the server refused with an error: [message] is the server's own sentence to
 * speak (`{"error": {"code", "message"}}`), null when the body had none (a proxy's HTML
 * page, for example).
 */
data class ServerError(val httpStatus: Int, val code: String?, val message: String?)

/** The answer to `POST /api/voice/turns` (device-contracts.md §4). */
sealed interface TurnResult {
    data class Started(
        val runId: String,
        /** Null when the server sent none (it always should). */
        val conversationId: String?,
        val heard: String,
        val request: String,
    ) : TurnResult

    data object Cancelled : TurnResult

    /** Status, nothing heard, or anything else the server wants said. */
    data class Say(val text: String) : TurnResult
    data class Unauthorized(val error: ServerError) : TurnResult
    data class Refused(val error: ServerError) : TurnResult

    /** No answer at all: no network, DNS, TLS, timeout. */
    data object Unreachable : TurnResult
}

/** The answer to `POST /api/voice/transcripts` (device-contracts.md §4). */
sealed interface TranscriptResult {
    /** What the transcription model heard, as it heard it. */
    data class Heard(val text: String) : TranscriptResult

    /** Nothing was heard: what to say. */
    data class Say(val text: String) : TranscriptResult
    data class Unauthorized(val error: ServerError) : TranscriptResult
    data class Refused(val error: ServerError) : TranscriptResult
    data object Unreachable : TranscriptResult
}

/** The answer to `POST /api/voice/replies` (device-contracts.md §4). */
sealed interface ReplyResult {
    data class Decided(val decision: String, val heard: String, val say: String? = null) : ReplyResult
    data class Unclear(val heard: String, val say: String) : ReplyResult
    data object NeedsTap : ReplyResult
    data object AlreadyDecided : ReplyResult
    data class Unauthorized(val error: ServerError) : ReplyResult
    data class Refused(val error: ServerError) : ReplyResult
    data object Unreachable : ReplyResult
}
