package app.anemo.voice.core

import java.util.concurrent.Executor

/** Delivers a [VoiceBackend]'s answers on [executor], the voice thread the controller lives on. */
class PostingBackend(private val inner: VoiceBackend, private val executor: Executor) : VoiceBackend {
    override fun sendTurn(wav: ByteArray, conversationId: String?, status: Boolean, onResult: (TurnResult) -> Unit) =
        inner.sendTurn(wav, conversationId, status) { r -> executor.execute { onResult(r) } }

    override fun sendReply(wav: ByteArray, approvalId: String, onResult: (ReplyResult) -> Unit) =
        inner.sendReply(wav, approvalId) { r -> executor.execute { onResult(r) } }
}
