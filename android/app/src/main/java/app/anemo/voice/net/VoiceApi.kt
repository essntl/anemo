package app.anemo.voice.net

import app.anemo.voice.core.ReplyResult
import app.anemo.voice.core.ServerError
import app.anemo.voice.core.TranscriptResult
import app.anemo.voice.core.TurnResult
import app.anemo.voice.core.VoiceBackend
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException

/**
 * `POST /api/voice/turns`, `/voice/transcripts` and `/voice/replies` (device-contracts.md §4). The
 * token goes in the `Authorization` header only. Nothing here logs.
 */
class VoiceApi(
    private val client: OkHttpClient,
    private val address: Address,
    private val token: String,
) : VoiceBackend {

    override fun sendTurn(wav: ByteArray?, conversationId: String?, status: Boolean, onResult: (TurnResult) -> Unit) {
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .apply { if (wav != null) addFormDataPart("audio", "recording.wav", wav.toRequestBody(WAV)) }
            .apply { if (conversationId != null) addFormDataPart("conversation_id", conversationId) }
            .apply { if (status) addFormDataPart("status", "true") }
            .build()
        post("voice/turns", body, onError = { onResult(TurnResult.Unreachable) }) { code, json ->
            onResult(turnResult(code, json))
        }
    }

    override fun sendReply(wav: ByteArray, approvalId: String, onResult: (ReplyResult) -> Unit) {
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("audio", "reply.wav", wav.toRequestBody(WAV))
            .addFormDataPart("approval_id", approvalId)
            .build()
        post("voice/replies", body, onError = { onResult(ReplyResult.Unreachable) }) { code, json ->
            onResult(replyResult(code, json))
        }
    }

    override fun transcribe(wav: ByteArray, onResult: (TranscriptResult) -> Unit) {
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("audio", "recording.wav", wav.toRequestBody(WAV))
            .build()
        post("voice/transcripts", body, onError = { onResult(TranscriptResult.Unreachable) }) { code, json ->
            onResult(transcriptResult(code, json))
        }
    }

    override fun sendText(
        text: String,
        conversationId: String?,
        voiceMode: Boolean,
        keepChat: Boolean,
        onResult: (TurnResult) -> Unit,
    ) {
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("text", text.take(MAX_TEXT_CHARS))
            .apply { if (conversationId != null) addFormDataPart("conversation_id", conversationId) }
            .apply { if (voiceMode) addFormDataPart("voice_mode", "true") }
            .apply { if (keepChat) addFormDataPart("keep_chat", "true") }
            .build()
        post("voice/turns", body, onError = { onResult(TurnResult.Unreachable) }) { code, json ->
            onResult(turnResult(code, json))
        }
    }

    /** Cancels every call in flight (the service stops). */
    fun cancelAll() = client.dispatcher.cancelAll()

    private fun post(
        path: String,
        body: MultipartBody,
        onError: () -> Unit,
        onResponse: (Int, JSONObject?) -> Unit,
    ) {
        val request = Request.Builder()
            .url(address.api(path))
            .header("Authorization", "Bearer $token")
            .post(body)
            .build()
        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) = onError()

            override fun onResponse(call: Call, response: Response) {
                val json = response.use { r ->
                    try {
                        r.body?.string()?.takeIf { it.isNotBlank() }?.let { JSONObject(it) }
                    } catch (e: IOException) {
                        null
                    } catch (e: JSONException) {
                        null // not JSON: a proxy's error page, for example
                    }
                }
                onResponse(response.code, json)
            }
        })
    }

    companion object {
        private val WAV = "audio/wav".toMediaType()
        private const val UNCLEAR = "Sorry, I didn't get that. Could you say it again?"

        /** The server's limit for `text`. */
        const val MAX_TEXT_CHARS = 4000

        fun transcriptResult(code: Int, json: JSONObject?): TranscriptResult {
            val heard = json?.stringOrNull("heard")
            val say = json?.stringOrNull("say")
            return when {
                code == 200 && !say.isNullOrBlank() -> TranscriptResult.Say(say)
                code == 200 && heard != null -> TranscriptResult.Heard(heard)
                code == 401 -> TranscriptResult.Unauthorized(error(code, json))
                else -> TranscriptResult.Refused(error(code, json))
            }
        }

        fun turnResult(code: Int, json: JSONObject?): TurnResult {
            val say = json?.stringOrNull("say")
            return when {
                code == 202 && json?.stringOrNull("run_id") != null -> TurnResult.Started(
                    runId = json.getString("run_id"),
                    conversationId = json.stringOrNull("conversation_id"),
                    heard = json.stringOrNull("heard").orEmpty(),
                    request = json.stringOrNull("request").orEmpty(),
                )
                code == 200 && json?.optBoolean("cancelled") == true -> TurnResult.Cancelled
                code in 200..299 && !say.isNullOrBlank() -> TurnResult.Say(say)
                code == 401 -> TurnResult.Unauthorized(error(code, json))
                else -> TurnResult.Refused(error(code, json))
            }
        }

        fun replyResult(code: Int, json: JSONObject?): ReplyResult = when {
            code == 200 && json != null && json.has("decided") && !json.isNull("decided") ->
                ReplyResult.Decided(json.getString("decided"), json.stringOrNull("heard").orEmpty(), json.stringOrNull("say"))
            code == 200 && json != null && json.has("decided") ->
                ReplyResult.Unclear(json.stringOrNull("heard").orEmpty(), json.stringOrNull("say")?.ifBlank { null } ?: UNCLEAR)
            code == 409 && error(code, json).code == "needs_tap" -> ReplyResult.NeedsTap
            code == 409 && error(code, json).code == "already_decided" -> ReplyResult.AlreadyDecided
            code == 401 -> ReplyResult.Unauthorized(error(code, json))
            else -> ReplyResult.Refused(error(code, json))
        }

        private fun error(code: Int, json: JSONObject?): ServerError {
            val e = json?.optJSONObject("error")
            return ServerError(code, e?.stringOrNull("code"), e?.stringOrNull("message"))
        }
    }
}
