/**
 * Controlling a thread (docs/specs/code-sessions.md §12.4): cancelling the running job,
 * sending a follow-up (or queueing one while the job runs), and where a job an agent started came from.
 */
import { type KeyboardEvent, type ReactNode, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { Clock, ListPlus, MessageSquare, Send, Square, TriangleAlert } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { confirmDialog } from '@/components/ui/dialogs'
import { Textarea } from '@/components/ui/Input'
import { toast } from '@/components/ui/toast'
import { useToastLift } from '@/components/ui/useToastLift'
import { useAutosize } from '@/hooks/useAutosize'
import { chatLink } from '@/lib/appLinks'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { startErrorMessage, useCancelJob, useFollowUp } from './api'
import { type QueuedMessage, codeQueue, useCodeQueue } from './queueStore'
import { sendQueued } from './sendQueued'
import type { CodeJob } from './threads'

/** Cancel: while the job runs on a computer that lets Anemo stop jobs (`cancel`; it needs no control, §12.5). */
export function CancelJobButton({ job }: { job: CodeJob }) {
  const cancel = useCancelJob()
  if (job.state !== 'running' || !job.device.cancel) return null
  const run = async () => {
    // A message waiting for this job goes out when it stops: say so before it does.
    const waiting = useCodeQueue.getState().byThread[job.thread_id || job.id]
    const stops = t('Claude Code stops on {device}. What it changed so far stays.', { device: job.device.name })
    const ok = await confirmDialog({
      title: t('Cancel this job?'),
      message: waiting && !waiting.held ? `${stops} ${t('Your queued message is then sent as a follow-up; remove it first to only stop.')}` : stops,
      confirmLabel: t('Cancel job'),
      cancelLabel: t('Keep running'),
      focusCancel: true,
      danger: true,
    })
    if (!ok) return
    cancel.mutate(job.id, { onError: (err) => toast({ message: errorMessage(err) }) })
  }
  return (
    <Button size="sm" variant="ghost" icon={<Square className="h-3.5 w-3.5" />} loading={cancel.isPending} onClick={() => void run()}>
      {t('Cancel job')}
    </Button>
  )
}

/** "From chat: <title>": the job was started by an agent in that chat. */
export function FromChat({ job }: { job: CodeJob }) {
  if (!job.conversation_id) return null
  return (
    <Link to={chatLink(job.conversation_id)}
      className="inline-flex min-w-0 max-w-full items-center gap-1.5 self-start rounded-full bg-surface-2 px-2.5 py-1 text-[12px] text-muted hover:bg-surface-hover hover:text-text">
      <MessageSquare aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 truncate">{t('From chat: {title}', { title: job.conversation_title || t('Untitled') })}</span>
    </Link>
  )
}

/** The message waiting for the running job to end, or held because it couldn't be sent by itself. */
function QueuedCard({ message, canSend, sending, onSend, onEdit, onRemove }: {
  message: QueuedMessage; canSend: boolean; sending: boolean; onSend: () => void; onEdit: () => void; onRemove: () => void
}) {
  const held = Boolean(message.held)
  return (
    <div data-testid="queued-message" className="mb-2 rounded-lg bg-surface-2 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={cn('flex min-w-[min(100%,14rem)] flex-1 items-center gap-1.5 text-[12px] font-medium', held ? 'text-warning' : 'text-muted')}>
          {held ? <TriangleAlert aria-hidden="true" className="h-3.5 w-3.5 shrink-0" /> : <Clock aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />}
          <span className="min-w-0">{held ? message.held : sending ? t('Sending the queued message…') : t('Queued: sent when this job ends')}</span>
        </span>
        {!sending && (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {held && canSend && <Button size="sm" variant="primary" onClick={onSend}>{t('Send now')}</Button>}
            <Button size="sm" variant="ghost" onClick={onEdit}>{t('Edit')}</Button>
            <Button size="sm" variant="ghost" onClick={onRemove}>{held ? t('Discard message') : t('Remove')}</Button>
          </span>
        )}
      </div>
      <p className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-[13px] [overflow-wrap:anywhere] max-sm:max-h-10">{message.text}</p>
    </div>
  )
}

/**
 * The box under a thread. After the last job has ended (with a session to resume, on a
 * computer that lets Anemo start jobs) it sends a follow-up. While the job runs it
 * queues one message, sent when the job ends (queueStore.ts): Claude Code takes nothing
 * in while it works. Otherwise nothing, or one line saying why. `onSent`: a message was
 * sent or queued (the thread goes to its end, where it shows); `title`: the thread's,
 * for the notices.
 */
export function FollowUpBox({ job, title, onSent }: { job: CodeJob; title?: string | null; onSent?: () => void }) {
  const qc = useQueryClient()
  const followUp = useFollowUp(job.id)
  const threadId = job.thread_id || job.id
  const queued = useCodeQueue((s) => s.byThread[threadId])
  // The draft lives with the queue: it survives opening another thread and a reload.
  const text = useCodeQueue((s) => s.drafts[threadId] ?? '')
  const setText = (next: string) => codeQueue.setDraft(threadId, next)
  const field = useRef<HTMLTextAreaElement>(null)
  useAutosize(field, text, 240)
  const running = job.state === 'running'
  const canStart = job.device.online && job.device.start

  // Sent as typed; only a blank one is refused.
  const blank = text.trim() === ''
  const sendable = !running && Boolean(job.session_id) && canStart
  // Back into the box (in front of what is there), where it is kept as the draft.
  const edit = () => {
    if (!queued) return
    setText(text.trim() ? `${queued.text}\n\n${text}` : queued.text)
    codeQueue.remove(threadId)
    field.current?.focus()
  }
  const remove = () => {
    if (!queued) return
    codeQueue.remove(threadId)
    toast({ message: queued.held ? t('Message discarded') : t('Queued message removed'), action: { label: t('Undo'), onClick: () => codeQueue.put(threadId, queued) } })
  }
  const card = queued && (
    <QueuedCard message={queued} canSend={sendable} sending={!running && !queued.held}
      onSend={() => { onSent?.(); void sendQueued(qc, threadId, job, title ?? job.title) }} onEdit={edit} onRemove={remove} />
  )

  if (running ? !job.device.start : !sendable) {
    // Nothing can be sent from here; a message that was waiting is still shown, to copy or drop.
    const why = running ? null
      : !job.session_id ? t('This job left no session to continue: start a new job to try again.')
      : !job.device.online
        ? t('{device} is offline: a follow-up can be sent once it is back.', { device: job.device.name })
        : t('{device} doesn’t let Anemo start Claude Code jobs: turn on “Let Anemo start Claude Code jobs” in Anemo Desktop to send a follow-up.', { device: job.device.name })
    if (!why && !card) return null
    return (
      <Dock>
        {card}
        {why && <p data-testid="follow-up-off" className="px-1 text-[12.5px] text-muted">{why}</p>}
      </Dock>
    )
  }

  const submit = () => {
    if (blank || followUp.isPending) return
    if (running) {
      codeQueue.add(threadId, job.id, text)
      setText('')
      onSent?.()
      return
    }
    followUp.mutate(text, {
      onSuccess: () => { setText(''); onSent?.() },
      onError: (err) => toast({ message: startErrorMessage(err) }),
    })
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }
  return (
    <Dock>
      {card}
      <form className="rounded-xl border border-border bg-surface p-2 shadow-soft focus-within:border-border-strong" onSubmit={(e) => { e.preventDefault(); submit() }}>
        <Textarea ref={field} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} rows={1} maxLength={100_000}
          aria-label={running ? t('Message for when this job ends') : t('Follow-up')}
          placeholder={running ? t('Queue the next message…') : t('Ask for more in the same session…')}
          readOnly={followUp.isPending}
          className="resize-none border-0 bg-transparent px-2 py-1.5 focus:ring-0 read-only:opacity-60" />
        <div className="mt-1 flex items-center justify-end gap-2">
          <span className="min-w-0 truncate text-[11.5px] text-subtle max-md:hidden">
            {!running ? t('Ctrl+Enter to send') : queued && !queued.held ? t('Ctrl+Enter adds it to the queued message') : t('Ctrl+Enter to queue · Claude Code takes it when this job ends')}
          </span>
          <Button type="submit" size="sm" variant={running ? 'secondary' : 'primary'} loading={followUp.isPending} disabled={blank}
            icon={running ? <ListPlus className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />}>
            {!running ? t('Send') : queued && !queued.held ? t('Add to queue') : t('Queue message')}
          </Button>
        </div>
      </form>
    </Dock>
  )
}

/** The strip under the thread's scrolling part, as wide as the thread. */
function Dock({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useToastLift(ref)
  return <div ref={ref} className="mx-auto w-full max-w-3xl px-4 pb-3 pt-1 md:px-8">{children}</div>
}
