package app.anemo.voice.net

import app.anemo.voice.core.ReplyResult
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
 * `POST /api/voice/turns` and `POST /api/voice/replies` (device-contracts.md §4). The
 * token goes in the `Authorization` header only. Nothing here logs.
 */
class VoiceApi(
    private val client: OkHttpClient,
    private val address: Address,
    private val token: String,
) : VoiceBackend {

    override fun sendTurn(wav: ByteArray, conversationId: String?, status: Boolean, onResult: (TurnResult) -> Unit) {
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("audio", "recording.wav", wav.toRequestBody(WAV))
            .apply { if (conversationId != null) addFormDataPart("conversation_id", conversationId) }
            .apply { if (status) addFormDataPart("status", "true") }
            .build()
        post("voice/turns", body, onError = { onResult(TurnResult.Failed(null)) }) { code, json ->
            onResult(turnResult(code, json))
        }
    }

    override fun sendReply(wav: ByteArray, approvalId: String, onResult: (ReplyResult) -> Unit) {
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("audio", "reply.wav", wav.toRequestBody(WAV))
            .addFormDataPart("approval_id", approvalId)
            .build()
        post("voice/replies", body, onError = { onResult(ReplyResult.Failed(null)) }) { code, json ->
            onResult(replyResult(code, json))
        }
    }

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
                        null
                    }
                }
                onResponse(response.code, json)
            }
        })
    }

    companion object {
        private val WAV = "audio/wav".toMediaType()
        private const val UNCLEAR = "Sorry, I didn't get that. Could you say it again?"

        fun turnResult(code: Int, json: JSONObject?): TurnResult = when {
            code == 202 && json != null && json.has("run_id") -> TurnResult.Started(
                runId = json.getString("run_id"),
                conversationId = json.optString("conversation_id"),
                heard = json.optString("heard"),
                request = json.optString("request"),
            )
            code == 200 && json?.optBoolean("cancelled") == true -> TurnResult.Cancelled
            code == 200 && json?.has("say") == true -> TurnResult.Say(json.optString("say"))
            code == 409 && errorCode(json) == "no_transcription_model" -> TurnResult.NoTranscriptionModel
            code == 422 -> TurnResult.UnsupportedAudio
            code == 401 -> TurnResult.Unauthorized
            else -> TurnResult.Failed(code)
        }

        fun replyResult(code: Int, json: JSONObject?): ReplyResult = when {
            code == 200 && json != null && json.has("decided") && !json.isNull("decided") ->
                ReplyResult.Decided(json.getString("decided"), json.optString("heard"))
            code == 200 && json != null && json.has("decided") ->
                ReplyResult.Unclear(json.optString("heard"), json.optString("say").ifBlank { UNCLEAR })
            code == 409 -> when (errorCode(json)) {
                "needs_tap" -> ReplyResult.NeedsTap
                "already_decided" -> ReplyResult.AlreadyDecided
                "no_transcription_model" -> ReplyResult.NoTranscriptionModel
                else -> ReplyResult.Failed(code)
            }
            code == 401 -> ReplyResult.Unauthorized
            else -> ReplyResult.Failed(code)
        }

        private fun errorCode(json: JSONObject?): String? = json?.optJSONObject("error")?.optString("code")
    }
}
