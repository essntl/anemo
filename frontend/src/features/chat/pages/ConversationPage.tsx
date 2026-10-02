import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router'
import { AppWindow, ExternalLink, GitBranch, Star, X } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { MenuButton, NewChatButton } from '@/app/mobileNav'
import { ActionMenu } from '@/components/ui/ActionMenu'
import { Button } from '@/components/ui/Button'
import { timelineKey } from '@/features/agents/api'
import { useShellOutput } from '@/features/agents/shellOutput'
import { useBrowserStatus } from '@/features/browser/api'
import { BrowserView } from '@/features/browser/BrowserView'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { RunActivity } from '@/features/agents/components/RunActivity'
import { type Mode, ModeSwitch } from '@/features/agents/components/ModeSwitch'
import { noticeMemoryEvent } from '@/features/memory/memoryNotice'
import { ProfilePicker } from '@/features/profiles/components/ProfilePicker'
import { useResumeRun } from '@/features/runs/api'
import { useSettings } from '@/features/settings/api'
import { useProjects } from '@/features/tasks/api'
import { cn } from '@/lib/cn'
import {
  type ChatMessage,
  type Conversation,
  conversationKey,
  conversationsKey,
  messagesKey,
  useBranch,
  useCancelRun,
  useConversation,
  useEditLast,
  useMessages,
  useRegenerate,
  useSendTurn,
  useUpdateConversation,
} from '../api'
import { useChatActions } from '../chatActions'
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

/** From this width up there is room for the browser next to the chat. */
const WIDE = '(min-width: 1024px)'

/** Opens the agent's browser for this chat in a window of its own. */
function popOutBrowser(conversationId: string) {
  window.open(`/browser/${conversationId}`, `anemo-browser-${conversationId}`, 'popup,width=1320,height=940')
}

/** The chat's menu in its header: the same actions as in the sidebar and the overview. */
function ChatMenu({ conversation }: { conversation: Conversation }) {
  return <ActionMenu actions={useChatActions(conversation)} label="Chat actions" />
}

export function ConversationPage() {
  const { conversationId = '' } = useParams()
  const navigate = useNavigate()
  const browser = useBrowserStatus()
  const wide = useMediaQuery(WIDE)
  const [browserOpen, setBrowserOpen] = useState(false)
  const qc = useQueryClient()
  const conversation = useConversation(conversationId)
  const messages = useMessages(conversationId)
  const settings = useSettings()
  const send = useSendTurn()
  const cancel = useCancelRun()
  const regenerate = useRegenerate()
  const editLast = useEditLast()
  const branch = useBranch()
  const projects = useProjects()
  const update = useUpdateConversation()
  const [modelOverride, setModelOverride] = useState<string | null>(null)
  const [modeOverride, setModeOverride] = useState<Mode | null>(null)
  const mode: Mode = modeOverride ?? (conversation.data?.default_mode === 'agent' ? 'agent' : 'chat')
  // undefined: not changed here, use the conversation's profile.
  const [profileOverride, setProfileOverride] = useState<string | null | undefined>(undefined)
  const profileId = profileOverride !== undefined ? profileOverride : (conversation.data?.profile_id ?? null)
  const resume = useResumeRun()

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
  const appendShellOutput = useShellOutput((s) => s.append)
  const onEvent = (event: RunEvent) => {
    noticeMemoryEvent(event, () => void qc.invalidateQueries({ queryKey: ['memories'] }))
    if (event.type === 'tool.progress') {
      appendShellOutput(String(event.data.tool_call_id), String(event.data.text ?? ''))
      return
    }
    if (activeRunId && /^(tool|approval|plan)\.|^run\.(status|pause)/.test(event.type)) {
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
  const lastUser = [...list].reverse().find((m) => m.role === 'user')
  // The last message can be edited when it is the one the last answer replied to.
  const canEditLast = !activeRunId && lastUser && lastAssistant && lastAssistant.seq === lastUser.seq + 1
  const project = projects.data?.find((p) => p.id === conversation.data?.project_id)
  const actionError = send.error ?? regenerate.error ?? cancel.error ?? resume.error ?? editLast.error ?? branch.error
  // A paused agent run: a message resumes it (the agent reads the message first).
  const paused = Boolean(activeRunId) && live.status === 'paused'

  return (
    <div className="flex h-full">
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-1.5 md:h-14 md:px-6">
        <MenuButton />
        <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold">
          {conversation.data?.title ?? ' '}
          {project && (
            <span className="ml-2 hidden items-center gap-1 align-middle text-[12px] font-normal text-muted sm:inline-flex">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: project.color }} /> {project.name}
            </span>
          )}
        </h1>
        {browser.data?.available && (
          // The agent's browser: beside the chat when there is room, else on its own page.
          <Button size="icon" variant={browserOpen && wide ? 'secondary' : 'ghost'} aria-label="Browser" aria-pressed={browserOpen && wide}
            title="The agent’s browser" onClick={() => (wide ? setBrowserOpen(!browserOpen) : void navigate(`/browser/${conversationId}`))}>
            <AppWindow className="h-4 w-4" />
          </Button>
        )}
        {conversation.data && (
          <Button
            size="icon"
            variant="ghost"
            aria-label={conversation.data.pinned ? 'Remove from favorites' : 'Add to favorites'}
            aria-pressed={conversation.data.pinned}
            onClick={() => update.mutate({ id: conversationId, body: { pinned: !conversation.data?.pinned } })}
          >
            <Star className={cn('h-4 w-4', conversation.data.pinned && 'fill-current text-warning')} />
          </Button>
        )}
        {conversation.data && <ChatMenu conversation={conversation.data} />}
        <NewChatButton />
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-5 md:px-6 md:py-8">
          {conversation.data?.branched_from_id && (
            <Link to={`/c/${conversation.data.branched_from_id}`}
              className="flex items-center gap-1.5 self-center rounded-full bg-surface-2 px-3 py-1 text-[12px] text-muted hover:text-text">
              <GitBranch className="h-3.5 w-3.5" /> Branched from another chat
            </Link>
          )}
          {list.map((m) => {
            if (m.role === 'user') {
              return (
                <UserBubble key={m.id} text={m.text} attachments={m.attachments} references={m.references}
                  onEdit={canEditLast && m.id === lastUser?.id
                    ? (text) => editLast.mutate({ conversationId, text, modelId: modelOverride })
                    : undefined} />
              )
            }
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
                onBranch={() =>
                  branch.mutate({ conversationId, uptoSeq: m.seq }, { onSuccess: (copy) => void navigate(`/c/${copy.id}`) })
                }
              />
            )
          })}
        </div>
      </div>

      <div className="mx-auto w-full max-w-3xl px-2 pb-2 md:px-6 md:pb-6">
        {actionError && <p className="mb-2 text-center text-[13px] text-error">{errorMessage(actionError)}</p>}
        <Composer
          running={Boolean(activeRunId) && !paused}
          placeholder={paused ? 'Paused. Send a message to resume with it…' : undefined}
          conversationId={conversationId}
          onSend={(text, attachmentIds, referenceIds) =>
            paused && activeRunId
              ? resume.mutate({ runId: activeRunId, message: text })
              : send.mutate({ conversationId, text, modelId: modelOverride, attachmentIds, referenceIds, mode, profileId })
          }
          onStop={() => activeRunId && cancel.mutate(activeRunId)}
          toolbar={
            <>
              <ModeSwitch mode={mode} onChange={setModeOverride} profileId={profileId} />
              {mode === 'agent' && <ProfilePicker value={profileId} onChange={setProfileOverride} />}
              <ModelPicker value={modelId} defaultModelId={defaultModelId} onChange={setModelOverride} />
            </>
          }
        />
      </div>
    </div>
    {browserOpen && wide && (
      <aside aria-label="The agent’s browser" className="h-full w-[46%] min-w-[420px] max-w-[900px] shrink-0 border-l border-border">
        <BrowserView conversationId={conversationId}
          actions={
            <>
              <Button size="icon" variant="ghost" aria-label="Open in a separate window" title="Open in a separate window"
                onClick={() => { popOutBrowser(conversationId); setBrowserOpen(false) }}>
                <ExternalLink className="h-4 w-4" />
              </Button>
              <Button size="icon" variant="ghost" aria-label="Hide browser" onClick={() => setBrowserOpen(false)}>
                <X className="h-4 w-4" />
              </Button>
            </>
          } />
      </aside>
    )}
    </div>
  )
}
