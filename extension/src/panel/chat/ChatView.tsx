/**
 * Chat with Anemo in the side panel: the same chats as in Anemo (they show up in both),
 * streaming answers, Stop, agent mode with approval cards. The open chat and unsent drafts
 * are kept in chrome.storage.local, so closing and reopening the panel resumes where you
 * were; an answer still being written is picked up again.
 */
import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowDown, BookOpen, Check, Copy, Globe, GraduationCap, List, Plus, Search, Timer } from 'lucide-react'
import { startLearningChat, type LearningAction } from '@/shared/learning'
import type { PageContext } from '@/shared/pageContext'
import { storage } from '@/shared/storage'
import { TERMINAL, type RunView } from '@/shared/runReducer'
import { Button } from '../ui/Button'
import { Notice } from '../ui/Notice'
import { ActionMenu } from '../ui/Menu'
import { cn } from '../lib/cn'
import { useSession } from '../state/useSession'
import { useStored } from '../state/useStored'
import { AgentActivity } from './AgentActivity'
import {
  conversationKey,
  conversationsKey,
  messagesKey,
  useAnemoSettings,
  useCancelRun,
  useConversation,
  useMessages,
  useSendTurn,
  type ChatMessage,
  type Mode,
} from './api'
import { Composer } from './Composer'
import { ConversationList } from './ConversationList'
import { Markdown } from './Markdown'
import { readActivePage } from './currentTab'
import { PagePreview, type PageState } from './PagePreview'
import { useRunStream } from './useRunStream'
import { useChatMenu } from './chatMenu'
import { TemporaryBadge } from './Temporary'
import { refusal, upload, type Pending } from './attachments'
import { SentAttachment } from './Attachments'
import { FindBar } from './FindBar'

const NEW = 'new'

/**
 * Keeps the view at the bottom while anything below grows (streamed text, a tool call,
 * an approval card that loads a moment later), unless you scrolled up.
 */
function useStickToBottom() {
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  // Scrolled up, away from the newest message: a button offers the way back down.
  const [away, setAway] = useState(false)
  useEffect(() => {
    const el = scroller.current
    const inner = content.current
    if (!el || !inner) return
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      setAway(!pinned.current)
    }
    const observer = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight
    })
    el.addEventListener('scroll', onScroll)
    observer.observe(inner)
    return () => {
      el.removeEventListener('scroll', onScroll)
      observer.disconnect()
    }
  }, [])
  const toBottom = () => {
    const el = scroller.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }
  return { scroller, content, away, toBottom }
}

/** Copies an answer as it was written (Markdown). */
function CopyAnswer({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(text).catch(() => undefined)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }
  return (
    <button type="button" onClick={() => void copy()} aria-label="Copy answer" title="Copy answer" className="flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-subtle hover:bg-surface-hover hover:text-text">
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

function httpOnly(url: string): string | undefined {
  return /^https?:\/\//i.test(url) ? url : undefined
}

function UserBubble({ message }: { message: ChatMessage }) {
  return (
    <div className="flex flex-col items-end gap-1.5" data-testid="user-message">
      {message.page && (
        <a href={httpOnly(message.page.url)} target="_blank" rel="noopener noreferrer" title={message.page.url} className="flex max-w-[88%] items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1 text-[11.5px] text-muted hover:text-text">
          <Globe className="h-3 w-3 shrink-0 text-accent" />
          <span className="truncate">{message.page.title || message.page.url}</span>
          <span className="shrink-0">· {message.page.word_count.toLocaleString()} words</span>
        </a>
      )}
      {message.attachments.length > 0 && (
        <div className="flex max-w-[88%] flex-wrap justify-end gap-1.5">
          {message.attachments.map((a) => (
            <SentAttachment key={a.id} id={a.id} name={a.filename} size={a.size} kind={a.kind} />
          ))}
        </div>
      )}
      {message.text && <div className="max-w-[88%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-accent-soft px-3 py-2 text-[13.5px]">{message.text}</div>}
    </div>
  )
}

function AssistantMessage({ message, live, conversationId }: { message: ChatMessage; live: RunView | null; conversationId: string }) {
  const { connection } = useSession()
  const text = live ? live.text : message.text
  const status = live ? live.status : message.status
  const error = live ? live.error : message.error
  const isAgent = message.mode === 'agent'
  const working = live !== null && !TERMINAL.includes(status)
  return (
    <div className="flex flex-col gap-2" data-testid="assistant-message">
      {isAgent && message.run_id && <AgentActivity runId={message.run_id} version={live?.timelineVersion ?? 0} conversationId={conversationId} />}
      {text ? <Markdown text={text} serverUrl={connection.serverUrl} /> : working ? <div className="flex items-center gap-1.5 text-[12.5px] text-muted"><span className="h-2 w-2 animate-pulse rounded-full bg-accent" />{status === 'waiting_approval' ? 'Waiting for you' : 'Thinking…'}</div> : null}
      {!working && message.attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {message.attachments.map((a) => (
            <SentAttachment key={a.id} id={a.id} name={a.filename} size={a.size} kind={a.kind} />
          ))}
        </div>
      )}
      {live?.notice && <div className="text-[11.5px] text-subtle">{live.notice}</div>}
      {status === 'failed' && <div className="text-[12.5px] text-error">{error ?? 'The answer failed.'}</div>}
      {status === 'cancelled' && <div className="text-[11.5px] text-subtle">Stopped.</div>}
      {!working && (text || (live?.modelLabel ?? message.model_label)) && (
        <div className="flex items-center gap-2 text-[11px] text-subtle">
          {(live?.modelLabel ?? message.model_label) && <span>{live?.modelLabel ?? message.model_label}</span>}
          {text && <CopyAnswer text={text} />}
        </div>
      )}
    </div>
  )
}

async function openChat(id: string | null): Promise<void> {
  const c = await storage.get('local', 'chat')
  await storage.set('local', 'chat', { conversationId: id, drafts: c?.drafts ?? {} })
}

async function saveDraft(key: string, text: string): Promise<void> {
  const c = await storage.get('local', 'chat')
  const drafts = { ...(c?.drafts ?? {}) }
  if (text) drafts[key] = text
  else delete drafts[key]
  await storage.set('local', 'chat', { conversationId: c?.conversationId ?? null, drafts })
}

/** The chat list, or the open chat. */
export function ChatView() {
  const stored = useStored('local', 'chat')
  const [showList, setShowList] = useState(false)
  // Switches at once (the storage write follows), so nothing typed right after a switch
  // lands in the chat being left.
  const [opened, setOpened] = useState<{ id: string | null; temporary?: boolean } | null>(null)
  // "Discuss in chat" from the right-click menu: a new chat with the page and the quote,
  // until you send it or open another chat.
  const pending = useStored('session', 'pendingCompose').value ?? null
  if (!stored.loaded) return null
  const composing = pending !== null
  const conversationId = composing ? null : opened ? opened.id : (stored.value?.conversationId ?? null)
  const open = (id: string | null, temporary = false) => {
    setShowList(false)
    setOpened({ id, temporary })
    if (pending) void storage.set('session', 'pendingCompose', null)
    void openChat(id)
  }
  if (showList && !composing) {
    return (
      <ConversationList
        current={conversationId}
        onOpen={open}
        onNew={(temporary) => open(null, temporary)}
        onCurrentDeleted={() => {
          setOpened({ id: null })
          void openChat(null)
        }}
      />
    )
  }
  const key = conversationId ?? NEW
  // Keyed by the chat: opening another one starts fresh (draft, mode, model, run, page).
  return (
    <Conversation
      key={`${key}:${pending?.at ?? ''}:${opened?.temporary ? 't' : ''}`}
      conversationId={conversationId}
      initialTemporary={!conversationId && Boolean(opened?.temporary)}
      initialDraft={pending ? pending.draft : (stored.value?.drafts?.[key] ?? '')}
      initialPage={pending?.page ?? null}
      onList={() => {
        if (pending) void storage.set('session', 'pendingCompose', null)
        setShowList(true)
      }}
      onOpen={open}
    />
  )
}

function Conversation({
  conversationId,
  initialDraft,
  initialPage,
  initialTemporary,
  onList,
  onOpen,
}: {
  conversationId: string | null
  initialDraft: string
  initialPage: PageContext | null
  initialTemporary: boolean
  onList: () => void
  onOpen: (id: string | null, temporary?: boolean) => void
}) {
  // A new chat can be temporary: deleted 5 minutes after its last message unless kept.
  const [temporary, setTemporary] = useState(initialTemporary)
  const { api } = useSession()
  const [pageState, setPageState] = useState<PageState>(initialPage ? { status: 'ready', page: initialPage } : { status: 'off' })
  const [learning, setLearning] = useState<LearningAction | null>(null)
  const readPageNow = async () => {
    setPageState({ status: 'loading' })
    setPageState(await readActivePage(api))
  }
  const togglePage = () => {
    if (pageState.status === 'off') void readPageNow()
    else setPageState({ status: 'off' })
  }
  const learn = async (action: LearningAction) => {
    setLearning(action)
    const state = await readActivePage(api)
    if (state.status !== 'ready') {
      setPageState(state)
      setLearning(null)
      return
    }
    try {
      onOpen(await startLearningChat(api, state.page, action))
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err))
    } finally {
      setLearning(null)
    }
  }
  const qc = useQueryClient()
  const conversation = useConversation(conversationId)
  const menu = useChatMenu(conversation.data, { onDeleted: () => onOpen(null) })
  const messages = useMessages(conversationId)
  const settings = useAnemoSettings()
  const send = useSendTurn()
  const cancel = useCancelRun()
  const key = conversationId ?? NEW
  const [draft, setDraft] = useState(initialDraft)
  const [modeChoice, setModeChoice] = useState<Mode | null>(null)
  const [modelId, setModelId] = useState<string | null>(null)
  const [profileChoice, setProfileChoice] = useState<string | null | undefined>(undefined)
  const [startedRun, setStartedRun] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [files, setFiles] = useState<Pending[]>([])
  const [finding, setFinding] = useState(false)
  const [queued, setQueued] = useState(false)

  const addFiles = (added: File[]) => {
    let count = files.length
    for (const file of added) {
      const key = crypto.randomUUID()
      const why = refusal(file, count)
      const preview = !why && file.type.startsWith('image/') ? URL.createObjectURL(file) : null
      setFiles((all) => [...all, { key, name: file.name || 'Pasted image', size: file.size, preview, status: why ? 'error' : 'uploading', error: why ?? undefined }])
      if (why) continue
      count += 1
      upload(api, file).then(
        (done) => setFiles((all) => all.map((f) => (f.key === key ? { ...f, status: 'ready', id: done.id } : f))),
        (err: unknown) => setFiles((all) => all.map((f) => (f.key === key ? { ...f, status: 'error', error: err instanceof Error ? err.message : 'The upload failed.' } : f))),
      )
    }
  }
  const removeFile = (key: string) =>
    setFiles((all) => {
      const gone = all.find((f) => f.key === key)
      if (gone?.preview) URL.revokeObjectURL(gone.preview)
      return all.filter((f) => f.key !== key)
    })
  const ready = files.filter((f) => f.status === 'ready' && f.id)
  const uploading = files.some((f) => f.status === 'uploading')

  const runId = startedRun ?? conversation.data?.active_run_id ?? null

  // Tell the worker which chat is in view: a finished agent run there needs no notification.
  useEffect(() => {
    const report = () =>
      void storage.set('session', 'panelFocus', { conversationId, visible: document.visibilityState === 'visible', at: Date.now() })
    const hide = () => void storage.set('session', 'panelFocus', { conversationId, visible: false, at: Date.now() })
    report()
    document.addEventListener('visibilitychange', report)
    window.addEventListener('pagehide', hide)
    return () => {
      document.removeEventListener('visibilitychange', report)
      window.removeEventListener('pagehide', hide)
    }
  }, [conversationId])
  // Ctrl+F (⌘F) finds in the open chat: Chrome's own find doesn't reach the side panel.
  useEffect(() => {
    if (!conversationId) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setFinding(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [conversationId])
  const profileId = profileChoice === undefined ? (conversation.data?.profile_id ?? null) : profileChoice

  const changeDraft = (text: string) => {
    setDraft(text)
    void saveDraft(key, text)
  }

  const live = useRunStream(runId, () => {
    if (!conversationId) return
    void qc.invalidateQueries({ queryKey: messagesKey(conversationId) })
    void qc.invalidateQueries({ queryKey: conversationKey(conversationId) })
    void qc.invalidateQueries({ queryKey: conversationsKey })
  })
  const running = runId !== null && !TERMINAL.includes(live.status)
  const { scroller, content, away, toBottom } = useStickToBottom()

  const defaultMode = (conversation.data?.default_mode as Mode | undefined) ?? settings.data?.general.default_chat_mode ?? 'chat'
  const mode = modeChoice ?? defaultMode
  const defaultModelId = conversation.data?.model_id ?? settings.data?.models.chat ?? null

  const page = pageState.status === 'ready' ? pageState.page : null
  const submit = () => {
    const text = draft.trim()
    if (uploading) {
      // Sent as soon as the files are up (the effect below), not dropped.
      if (text || page || files.some((f) => f.status !== 'error')) setQueued(true)
      return
    }
    setQueued(false)
    if ((!text && !page && ready.length === 0) || running || pageState.status === 'loading') return
    setSendError(null)
    changeDraft('')
    const sentPage = page
    setPageState({ status: 'off' }) // per message: the next one has no page unless asked
    const sentFiles = files
    setFiles([])
    send.mutate(
      { conversationId, text, mode, modelId, profileId, page: sentPage, attachmentIds: ready.map((f) => f.id!), temporary: !conversationId && temporary },
      {
        onSuccess: ({ conversationId: id, turn }) => {
          if (id !== conversationId) onOpen(id) // a new chat: it opens with its run
          else setStartedRun(turn.run_id)
        },
        // A message that couldn't be sent goes back into the box.
        onError: (err) => {
          changeDraft(text)
          if (sentPage) setPageState({ status: 'ready', page: sentPage })
          setFiles(sentFiles)
          setSendError(err.message)
        },
      },
    )
  }

  // Send was pressed while files were uploading: go now that they are up.
  const submitLatest = useRef(submit)
  useEffect(() => {
    submitLatest.current = submit
  })
  useEffect(() => {
    if (queued && !uploading) submitLatest.current()
  }, [queued, uploading])

  if (conversationId && conversation.isError) {
    return (
      <div className="p-3">
        <Notice tone="warning" title="This chat isn’t available" actions={<Button size="sm" onClick={() => onOpen(null)}>New chat</Button>}>
          It may have been deleted in Anemo.
        </Notice>
      </div>
    )
  }

  const list = messages.data ?? []
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-1.5">
        <Button size="icon" variant="ghost" aria-label="All chats" title="All chats" onClick={onList} icon={<List className="h-4 w-4" />} />
        <div className="min-w-0 flex-1 truncate px-1 text-[13.5px] font-semibold" title={conversation.data?.title}>
          {conversationId ? (conversation.data?.title ?? '…') : temporary ? 'Temporary chat' : 'New chat'}
        </div>
        {conversation.data?.temporary && <TemporaryBadge conversation={conversation.data} />}
        {conversationId && <Button size="icon" variant="ghost" aria-label="Find in this chat" title="Find in this chat (Ctrl+F)" onClick={() => setFinding((v) => !v)} icon={<Search className="h-4 w-4" />} />}
        {conversation.data && <ActionMenu actions={menu.actions} label="Chat actions" />}
        <Button size="icon" variant="ghost" aria-label="New chat" title="New chat" onClick={() => onOpen(null)} icon={<Plus className="h-4 w-4" />} />
        {menu.dialogs}
      </div>
      {finding && <FindBar root={content} version={list.length + (live.text?.length ?? 0)} onClose={() => setFinding(false)} />}
      {menu.error && <div className="px-3 pt-2"><Notice tone="error" title="That didn’t work">{menu.error}</Notice></div>}
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div ref={content} className="flex min-h-full flex-col">
        {!conversationId && list.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-1.5 text-center">
            <div className={cn('mb-1 flex h-11 w-11 items-center justify-center rounded-2xl', temporary ? 'border-2 border-dashed border-accent/60 text-accent' : 'bg-accent-soft')}>
              {temporary ? <Timer className="h-5 w-5" /> : <img src="/icons/icon-48.png" alt="" className="h-7 w-7 rounded-lg" />}
            </div>
            <div className="text-[15px] font-semibold">{temporary ? 'Temporary chat' : 'What can I help with?'}</div>
            <p className="max-w-[17rem] text-[12.5px] text-muted">
              {temporary ? 'Deleted 5 minutes after the last message, unless you keep it. Nothing is remembered from it.' : 'Chats started here are in Anemo too.'}
            </p>
            <button
              type="button"
              aria-pressed={temporary}
              onClick={() => setTemporary(!temporary)}
              className={cn('mt-1 flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-medium', temporary ? 'border-accent bg-accent-soft text-accent' : 'border-border text-muted hover:border-border-strong hover:text-text')}
            >
              <Timer className="h-3.5 w-3.5" /> Temporary chat
            </button>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <Button size="sm" icon={<BookOpen className="h-3.5 w-3.5" />} loading={learning === 'summarize'} disabled={learning !== null} onClick={() => void learn('summarize')}>
                Summarize this page
              </Button>
              <Button size="sm" icon={<GraduationCap className="h-3.5 w-3.5" />} loading={learning === 'quiz'} disabled={learning !== null} onClick={() => void learn('quiz')}>
                Quiz me on it
              </Button>
            </div>
          </div>
        )}
        <div className="flex flex-col gap-4">
          {list.map((m) =>
            m.role === 'user' ? (
              <UserBubble key={m.id} message={m} />
            ) : (
              <AssistantMessage key={m.id} message={m} conversationId={conversationId ?? ''} live={m.run_id && m.run_id === runId ? live : null} />
            ),
          )}
        </div>
        {sendError && <div className="mt-3"><Notice tone="error" title="Not sent">{sendError}</Notice></div>}
        </div>
      </div>
      {away && (
        <div className="relative h-0">
          <button type="button" onClick={toBottom} aria-label="Go to the newest message" title="Go to the newest message" className="absolute bottom-2 left-1/2 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-card text-muted shadow-float hover:text-text">
            <ArrowDown className="h-4 w-4" />
          </button>
        </div>
      )}
      <Composer
        draft={draft}
        onDraft={changeDraft}
        onSend={submit}
        onStop={() => runId && cancel.mutate(runId)}
        running={running}
        sending={send.isPending || queued}
        mode={mode}
        onMode={setModeChoice}
        modelId={modelId}
        defaultModelId={defaultModelId}
        onModel={setModelId}
        profileId={profileId}
        onProfile={setProfileChoice}
        pageOn={pageState.status !== 'off'}
        onTogglePage={togglePage}
        canSendEmpty={page !== null || ready.length > 0}
        files={files}
        onAddFiles={addFiles}
        onRemoveFile={removeFile}
        uploading={uploading}
        queued={queued}
        above={<PagePreview state={pageState} onRefresh={() => void readPageNow()} onRemove={() => setPageState({ status: 'off' })} />}
      />
    </div>
  )
}
