import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { Maximize2, SquarePen } from 'lucide-react'
import { ApiError, errorMessage } from '@/api/client'
import { refreshTimeline, useDecide, useTimeline } from '@/features/agents/api'
import { ApprovalDock } from '@/features/agents/components/ApprovalCard'
import { RunActivity } from '@/features/agents/components/RunActivity'
import { pendingQuestion } from '@/features/agents/question'
import { useShellOutput } from '@/features/agents/shellOutput'
import { noticeMemoryEvent } from '@/features/memory/memoryNotice'
import { useResumeRun } from '@/features/runs/api'
import {
  type ChatMessage,
  type Conversation,
  conversationKey,
  conversationsKey,
  messagesKey,
  useCancelRun,
  useConversation,
  useMessages,
  useSendTurn,
} from '../api'
import { type RunEvent, type RunView, useRunStream } from '../runStream'
import { useStickToBottom } from '../useStickToBottom'
import { Composer } from './Composer'
import { AssistantMessage, UserBubble } from './MessageBubble'

interface SideChatProps {
  /** The chat shown; null until the first message is sent. */
  conversationId: string | null
  /** Makes the chat, for the first message. */
  create: () => Promise<Conversation>
  /** The chat was made and its first message sent. */
  onCreated: (conversation: Conversation) => void
  /** Leave this chat and start another with the next message. */
  onRestart: () => void
  /** The chat no longer exists (it was deleted elsewhere). */
  onGone: () => void
  /**
   * Runs before a message goes out and returns the text to send (what the chat is about
   * can be added here). `first`: the chat's first message. Reject to stop the send.
   */
  prepare?: (text: string, first: boolean) => Promise<string> | string
  /** What to show of a sent message (takes off what `prepare` added). */
  display?: (text: string) => string
  /** Shown while the chat has no messages; `ask` sends one. */
  empty: (ask: (text: string) => void) => ReactNode
  placeholder?: string
}

const same = (text: string) => text
const HEAD_BUTTON = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-hover hover:text-text pointer-coarse:h-9 pointer-coarse:w-9'

/** The column both states share: what scrolls, and the message box under it. */
function Column({ scroll, children, footer }: { scroll?: React.Ref<HTMLDivElement>; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scroll} className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      <div className="shrink-0 p-2 pt-1">{footer}</div>
    </div>
  )
}

/**
 * A small chat beside something else (a document): the messages, what the agent waits
 * for, and the message box, in a narrow column. It talks to an agent, so the assistant
 * can act on what the chat is about. The same chat is in the chat list; "Open as a full
 * chat" goes there for everything this small view leaves out.
 */
export function SideChat(props: SideChatProps) {
  const { conversationId, create, onCreated, prepare = same, empty, placeholder } = props
  const qc = useQueryClient()
  const send = useSendTurn()
  // The first message, shown while its chat is being made.
  const [starting, setStarting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (conversationId) return <Thread key={conversationId} {...props} conversationId={conversationId} />

  const start = async (text: string, attachmentIds: string[] = [], referenceIds: string[] = [], skillId: string | null = null) => {
    setError(null)
    setStarting(text)
    try {
      const body = await prepare(text, true)
      const conversation = await create()
      // In the cache before the message goes out, so the run it starts is noted on it.
      qc.setQueryData(conversationKey(conversation.id), conversation)
      await send.mutateAsync({
        conversationId: conversation.id, text: body, modelId: null, attachmentIds, referenceIds, mode: 'agent',
        profileId: conversation.profile_id ?? null, skillId,
      })
      onCreated(conversation)
    } catch (err) {
      setError(errorMessage(err))
      setStarting(null)
      throw err // the message box puts the message back
    }
  }

  return (
    <Column footer={
      <>
        {error && <p role="alert" className="mb-2 px-1 text-[13px] text-error">{error}</p>}
        <Composer running={false} disabled={starting !== null} autoFocus={false} placeholder={placeholder} onSend={start} />
      </>
    }>
      {starting === null ? empty((text) => void start(text).catch(() => undefined)) : (
        <div className="flex flex-col gap-4 p-3">
          <UserBubble text={starting} />
          <AssistantMessage text="" status="queued" />
        </div>
      )}
    </Column>
  )
}

function Thread({ conversationId, onRestart, onGone, prepare = same, display = same, empty, placeholder }: SideChatProps & { conversationId: string }) {
  const qc = useQueryClient()
  const conversation = useConversation(conversationId)
  const messages = useMessages(conversationId)
  const send = useSendTurn()
  const cancel = useCancelRun()
  const resume = useResumeRun()
  const [error, setError] = useState<string | null>(null)
  const activeRunId = conversation.data?.active_run_id ?? null

  // Deleted elsewhere: the next message starts a new chat.
  const gone = conversation.error instanceof ApiError && conversation.error.status === 404
  useEffect(() => {
    if (gone) onGone()
  }, [gone, onGone])

  const onFinished = (view: RunView) => {
    // Show the final state at once, then reconcile with the server's copy.
    qc.setQueryData<ChatMessage[]>(messagesKey(conversationId), (old) =>
      old?.map((m) =>
        m.run_id === activeRunId
          ? { ...m, text: view.text, reasoning: view.reasoning || null, error: view.error, status: view.status === 'completed' ? 'complete' : view.status }
          : m,
      ),
    )
    void qc.invalidateQueries({ queryKey: messagesKey(conversationId) })
    void qc.invalidateQueries({ queryKey: conversationKey(conversationId) })
    void qc.invalidateQueries({ queryKey: conversationsKey })
  }
  const appendShellOutput = useShellOutput((s) => s.append)
  const onEvent = (event: RunEvent) => {
    noticeMemoryEvent(event, () => void qc.invalidateQueries({ queryKey: ['memories'] }))
    if (event.type === 'tool.progress') {
      appendShellOutput(String(event.data.tool_call_id), String(event.data.text ?? ''))
      return
    }
    if (activeRunId && /^(tool|approval|plan)\.|^run\.(status|pause)/.test(event.type)) void refreshTimeline(qc, activeRunId)
  }
  const live = useRunStream(activeRunId, onFinished, onEvent)
  // The agent asked something: a message is the answer.
  const question = pendingQuestion(useTimeline(activeRunId).data?.tool_calls)
  const answer = useDecide(activeRunId ?? '')
  // A paused run: a message resumes it (the agent reads the message first).
  const paused = Boolean(activeRunId) && live.status === 'paused'

  // Whichever signal comes first (this run's stream or the app-wide event), the finished
  // message is loaded again once the run is no longer going.
  const previousRun = useRef(activeRunId)
  useEffect(() => {
    if (previousRun.current && !activeRunId) void qc.invalidateQueries({ queryKey: messagesKey(conversationId) })
    previousRun.current = activeRunId
  }, [activeRunId, conversationId, qc])

  const list = messages.data ?? []
  const scroll = useStickToBottom([list.length, live.text, live.reasoning])

  const onSend = async (text: string, attachmentIds: string[] = [], referenceIds: string[] = [], skillId: string | null = null) => {
    setError(null)
    try {
      if (question) return await answer.mutateAsync({ approvalId: question.approval!.id, decision: 'approve', answer: text })
      if (paused && activeRunId) return await resume.mutateAsync({ runId: activeRunId, message: text })
      const body = await prepare(text, false)
      return await send.mutateAsync({
        conversationId, text: body, modelId: null, attachmentIds, referenceIds, mode: 'agent',
        profileId: conversation.data?.profile_id ?? null, skillId,
      })
    } catch (err) {
      setError(errorMessage(err))
      throw err // the message box puts the message back
    }
  }

  return (
    <Column scroll={scroll} footer={
      <>
        {error && <p role="alert" className="mb-2 px-1 text-[13px] text-error">{error}</p>}
        {/* What the agent waits for stays in sight here, whatever the chat is scrolled to. */}
        <ApprovalDock runId={activeRunId} />
        <Composer
          running={Boolean(activeRunId) && !paused && !question}
          autoFocus={false}
          placeholder={question ? 'Answer the agent’s question…' : paused ? 'Paused. Send a message to resume with it…' : placeholder}
          conversationId={conversationId}
          skills={!question && !paused}
          filesOnly={!question && !paused}
          onSend={onSend}
          onStop={() => activeRunId && cancel.mutate(activeRunId)}
        />
      </>
    }>
      <div className="sticky top-0 z-10 flex h-9 items-center gap-0.5 border-b border-border bg-surface pl-3 pr-1.5">
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted" title={conversation.data?.title}>{conversation.data?.title}</span>
        <Link to={`/c/${conversationId}`} aria-label="Open as a full chat" title="Open as a full chat" className={HEAD_BUTTON}>
          <Maximize2 className="h-3.5 w-3.5" />
        </Link>
        <button type="button" aria-label="Start a new chat" title="Start a new chat (this one stays in your chats)" onClick={onRestart} className={HEAD_BUTTON}>
          <SquarePen className="h-3.5 w-3.5" />
        </button>
      </div>
      {messages.data && list.length === 0 ? empty((text) => void onSend(text).catch(() => undefined)) : (
        <div className="flex flex-col gap-4 p-3">
          {list.map((m) => {
            if (m.role === 'user') {
              return <UserBubble key={m.id} text={display(m.text)} attachments={m.attachments} references={m.references} skill={m.skill} />
            }
            const activity = (isLive: boolean) => (m.mode === 'agent' && m.run_id ? <RunActivity runId={m.run_id} live={isLive} docked={isLive} /> : undefined)
            return m.run_id === activeRunId && m.status === 'streaming' ? (
              <AssistantMessage key={m.id} text={live.text} reasoning={live.reasoning}
                status={live.status === 'queued' || live.status === 'running' ? 'streaming' : live.status}
                error={live.error} modelLabel={live.modelLabel} notice={live.notice} activity={activity(true)} questions={live.questions} />
            ) : (
              <AssistantMessage key={m.id} text={m.text} reasoning={m.reasoning} status={m.status} error={m.error} modelLabel={m.model_label}
                questions={m.questions} files={m.attachments} activity={activity(false)} />
            )
          })}
        </div>
      )}
    </Column>
  )
}
