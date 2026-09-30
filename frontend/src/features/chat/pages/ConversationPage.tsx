import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router'
import { Pin, PinOff } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { timelineKey } from '@/features/agents/api'
import { RunActivity } from '@/features/agents/components/RunActivity'
import { type Mode, ModeSwitch } from '@/features/agents/components/ModeSwitch'
import { useSettings } from '@/features/settings/api'
import {
  type ChatMessage,
  conversationKey,
  conversationsKey,
  messagesKey,
  useCancelRun,
  useConversation,
  useMessages,
  useRegenerate,
  useSendTurn,
  useUpdateConversation,
} from '../api'
import { AssistantMessage, UserBubble } from '../components/MessageBubble'
import { Composer } from '../components/Composer'
import { ModelPicker } from '../components/ModelPicker'
import { type RunEvent, type RunView, useRunStream } from '../runStream'

/** Keeps the view pinned to the bottom while new text streams in, unless the user scrolled up. */
function useStickToBottom(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [])
  useLayoutEffect(() => {
    const el = ref.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [dep])
  return ref
}

export function ConversationPage() {
  const { conversationId = '' } = useParams()
  const qc = useQueryClient()
  const conversation = useConversation(conversationId)
  const messages = useMessages(conversationId)
  const settings = useSettings()
  const send = useSendTurn()
  const cancel = useCancelRun()
  const regenerate = useRegenerate()
  const update = useUpdateConversation()
  const [modelOverride, setModelOverride] = useState<string | null>(null)
  const [modeOverride, setModeOverride] = useState<Mode | null>(null)
  const mode: Mode = modeOverride ?? (conversation.data?.default_mode === 'agent' ? 'agent' : 'chat')

  const activeRunId = conversation.data?.active_run_id ?? null
  const modelId = modelOverride ?? conversation.data?.model_id ?? null
  const defaultModelId = settings.data?.models.chat ?? null

  const onFinished = (view: RunView) => {
    // Show the final state immediately, then reconcile with the server copy.
    qc.setQueryData<ChatMessage[]>(messagesKey(conversationId), (old) =>
      old?.map((m) =>
        m.run_id === activeRunId
          ? { ...m, text: view.text, reasoning: view.reasoning || null, error: view.error,
              status: view.status === 'completed' ? 'complete' : view.status }
          : m,
      ),
    )
    void qc.invalidateQueries({ queryKey: messagesKey(conversationId) })
    void qc.invalidateQueries({ queryKey: conversationKey(conversationId) })
    void qc.invalidateQueries({ queryKey: conversationsKey })
  }
  const onEvent = (event: RunEvent) => {
    if (activeRunId && /^(tool|approval|plan)\./.test(event.type)) {
      void qc.invalidateQueries({ queryKey: timelineKey(activeRunId) })
    }
  }
  const live = useRunStream(activeRunId, onFinished, onEvent)

  // Whichever signal arrives first (this run's stream or the app-wide event),
  // make sure the finished message is reloaded once the run is no longer active.
  const previousRun = useRef(activeRunId)
  useEffect(() => {
    if (previousRun.current && !activeRunId) {
      void qc.invalidateQueries({ queryKey: messagesKey(conversationId) })
    }
    previousRun.current = activeRunId
  }, [activeRunId, conversationId, qc])
  const scrollRef = useStickToBottom([messages.data?.length, live.text, live.reasoning])

  const list = messages.data ?? []
  const lastAssistant = [...list].reverse().find((m) => m.role === 'assistant')
  const actionError = send.error ?? regenerate.error ?? cancel.error

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-6">
        <h1 className="truncate text-[15px] font-semibold">{conversation.data?.title ?? ' '}</h1>
        {conversation.data && (
          <Button
            size="icon"
            variant="ghost"
            aria-label={conversation.data.pinned ? 'Unpin' : 'Pin'}
            onClick={() => update.mutate({ id: conversationId, body: { pinned: !conversation.data?.pinned } })}
          >
            {conversation.data.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
          </Button>
        )}
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8">
          {list.map((m) => {
            if (m.role === 'user') return <UserBubble key={m.id} text={m.text} attachments={m.attachments} />
            const isLive = m.run_id === activeRunId && m.status === 'streaming'
            return isLive ? (
              <AssistantMessage
                key={m.id}
                text={live.text}
                reasoning={live.reasoning}
                status={live.status === 'queued' || live.status === 'running' ? 'streaming' : live.status}
                error={live.error}
                modelLabel={live.modelLabel}
                notice={live.notice}
                activity={m.mode === 'agent' && m.run_id ? <RunActivity runId={m.run_id} live /> : undefined}
              />
            ) : (
              <AssistantMessage
                key={m.id}
                text={m.text}
                reasoning={m.reasoning}
                status={m.status}
                error={m.error}
                modelLabel={m.model_label}
                activity={m.mode === 'agent' && m.run_id ? <RunActivity runId={m.run_id} live={false} /> : undefined}
                onRegenerate={
                  m.id === lastAssistant?.id && !activeRunId
                    ? () => regenerate.mutate({ conversationId, modelId: modelOverride })
                    : undefined
                }
              />
            )
          })}
        </div>
      </div>

      <div className="mx-auto w-full max-w-3xl px-6 pb-6">
        {actionError && <p className="mb-2 text-center text-[13px] text-error">{errorMessage(actionError)}</p>}
        <Composer
          running={Boolean(activeRunId)}
          onSend={(text, attachmentIds) =>
            send.mutate({ conversationId, text, modelId: modelOverride, attachmentIds, mode })
          }
          onStop={() => activeRunId && cancel.mutate(activeRunId)}
          toolbar={
            <>
              <ModeSwitch mode={mode} onChange={setModeOverride} />
              <ModelPicker value={modelId} defaultModelId={defaultModelId} onChange={setModelOverride} />
            </>
          }
        />
      </div>
    </div>
  )
}
