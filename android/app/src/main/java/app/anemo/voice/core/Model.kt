package app.anemo.voice.core

/** What a run waits for (device-contracts.md §2, `approval.requested`). */
data class Approval(
    val id: String,
    val runId: String,
    val kind: Kind,
    val summary: String,
    val risk: String,
    val question: String? = null,
    val options: List<String> = emptyList(),
    val steps: List<String> = emptyList(),
) {
    enum class Kind { Action, Question, Plan }

    val dangerous: Boolean get() = risk == "dangerous"
}

/** Events a phone gets on its WebSocket. Unknown events and kinds never become one. */
sealed interface DeviceEvent {
    data class RunStatus(val runId: String, val status: String) : DeviceEvent
    data class ApprovalRequested(val approval: Approval) : DeviceEvent
    data class ApprovalDecided(val approvalId: String, val decision: String) : DeviceEvent
    data class VoiceSay(
        val runId: String,
        val conversationId: String,
        val text: String,
        val more: Boolean,
    ) : DeviceEvent
}

/** The answer to `POST /api/voice/turns` (device-contracts.md §4). */
sealed interface TurnResult {
    data class Started(
        val runId: String,
        val conversationId: String,
        val heard: String,
        val request: String,
    ) : TurnResult

    data object Cancelled : TurnResult
    data class Say(val text: String) : TurnResult
    data object NoTranscriptionModel : TurnResult
    data object UnsupportedAudio : TurnResult
    data object Unauthorized : TurnResult
    data class Failed(val httpStatus: Int?) : TurnResult
}

/** The answer to `POST /api/voice/replies` (device-contracts.md §4). */
sealed interface ReplyResult {
    data class Decided(val decision: String, val heard: String) : ReplyResult
    data class Unclear(val heard: String, val say: String) : ReplyResult
    data object NeedsTap : ReplyResult
    data object AlreadyDecided : ReplyResult
    data object NoTranscriptionModel : ReplyResult
    data object Unauthorized : ReplyResult
    data class Failed(val httpStatus: Int?) : ReplyResult
}
