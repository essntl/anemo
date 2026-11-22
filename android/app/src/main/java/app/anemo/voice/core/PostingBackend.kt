package app.anemo.voice.core

import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException

/**
 * Delivers a [VoiceBackend]'s answers on [executor], the voice thread the controller lives
 * on. An answer that arrives after the service stopped (the executor is shut down) is
 * dropped instead of crashing OkHttp's thread.
 */
class PostingBackend(private val inner: VoiceBackend, private val executor: Executor) : VoiceBackend {
    override fun sendTurn(wav: ByteArray?, conversationId: String?, status: Boolean, onResult: (TurnResult) -> Unit) =
        inner.sendTurn(wav, conversationId, status) { r -> post { onResult(r) } }

    override fun sendReply(wav: ByteArray, approvalId: String, onResult: (ReplyResult) -> Unit) =
        inner.sendReply(wav, approvalId) { r -> post { onResult(r) } }

    private fun post(block: () -> Unit) {
        try {
            executor.execute(block)
        } catch (e: RejectedExecutionException) {
            // stopped meanwhile: nobody is listening for this answer any more
        }
    }
}
