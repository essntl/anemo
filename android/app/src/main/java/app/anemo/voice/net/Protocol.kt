package app.anemo.voice.net

import app.anemo.voice.core.Approval
import app.anemo.voice.core.DeviceEvent
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/** Messages from the server on `/api/devices/ws` (device-contracts.md §2 and §6). */
sealed interface ServerMessage {
    data class Welcome(val deviceName: String, val missed: Boolean, val cursor: String?) : ServerMessage
    data object Pong : ServerMessage

    /** [event] is null for an event or approval kind this app doesn't know: ignore it. */
    data class Event(val id: String, val event: DeviceEvent?) : ServerMessage
    data class Notice(val text: String) : ServerMessage
    data object Unknown : ServerMessage
}

/** Building and reading the WebSocket's JSON messages. */
object Protocol {
    const val KIND = "phone"

    fun hello(token: String, version: String, lastId: String?): String =
        JSONObject()
            .put("type", "hello")
            .put("token", token)
            .put("kind", KIND)
            .put("version", version)
            .put("last_id", lastId ?: JSONObject.NULL)
            .toString()

    fun ping(): String = JSONObject().put("type", "ping").toString()

    fun parse(text: String): ServerMessage = try {
        val o = JSONObject(text)
        when (o.optString("type")) {
            "welcome" -> ServerMessage.Welcome(
                deviceName = o.optJSONObject("device")?.optString("name").orEmpty(),
                missed = o.optBoolean("missed", false),
                cursor = o.stringOrNull("cursor"),
            )
            "pong" -> ServerMessage.Pong
            "event" -> ServerMessage.Event(
                id = o.getString("id"),
                event = event(o.getString("event"), o.optJSONObject("data") ?: JSONObject()),
            )
            "notice" -> ServerMessage.Notice(o.optString("text"))
            else -> ServerMessage.Unknown
        }
    } catch (e: JSONException) {
        ServerMessage.Unknown
    }

    private fun event(type: String, d: JSONObject): DeviceEvent? = when (type) {
        "run.status" -> DeviceEvent.RunStatus(d.getString("run_id"), d.getString("status"))
        "voice.say" -> DeviceEvent.VoiceSay(
            runId = d.getString("run_id"),
            conversationId = d.getString("conversation_id"),
            text = d.getString("text"),
            more = d.optBoolean("more", false),
        )
        "approval.requested" -> approval(d)?.let { DeviceEvent.ApprovalRequested(it) }
        "approval.decided" -> DeviceEvent.ApprovalDecided(d.getString("approval_id"), d.optString("decision"))
        else -> null
    }

    private fun approval(d: JSONObject): Approval? {
        val kind = when (d.optString("kind")) {
            "action" -> Approval.Kind.Action
            "question" -> Approval.Kind.Question
            "plan" -> Approval.Kind.Plan
            else -> return null
        }
        return Approval(
            id = d.getString("approval_id"),
            runId = d.optString("run_id"),
            kind = kind,
            summary = d.optString("summary"),
            risk = d.stringOrNull("risk") ?: "safe",
            question = d.stringOrNull("question"),
            options = d.optJSONArray("options").strings(),
            steps = d.optJSONArray("steps").strings(),
        )
    }

    private fun JSONObject.stringOrNull(key: String): String? =
        if (!has(key) || isNull(key)) null else optString(key)

    private fun JSONArray?.strings(): List<String> {
        if (this == null) return emptyList()
        return (0 until length()).mapNotNull { i -> opt(i)?.takeIf { it != JSONObject.NULL }?.toString() }
    }
}
