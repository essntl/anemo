/**
 * Controlling a thread (docs/specs/code-sessions.md §12.4, §15): cancelling the running job,
 * sending a follow-up, or a message for the running job (queued for its next step, or sent
 * now, interrupting it), with images (§13), and where a job an agent started came from.
 */
import { type KeyboardEvent, type ReactNode, useCallback, useRef } from 'react'
import { Link } from 'react-router'
import { Clock, ListPlus, Loader2, MessageSquare, Square, TriangleAlert, Zap } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { confirmDialog } from '@/components/ui/dialogs'
import { MESSAGE_BOX, MESSAGE_BOX_BORDER, MESSAGE_TEXT, SendButton } from '@/components/ui/MessageBox'
import { toast } from '@/components/ui/toast'
import { useToastLift } from '@/components/ui/useToastLift'
import { matchesShortcut, SHORTCUTS } from '@/features/shortcuts/registry'
import { useAutosize } from '@/hooks/useAutosize'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { chatLink } from '@/lib/appLinks'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import {
  type CodeMessage, isWaiting, startErrorMessage, useCancelJob, useFollowUp, useRemoveMessage, useSendMessage, useSendMessageNow,
  useThreadMessages,
} from './api'
import { type CodeImage, MAX_IMAGES, useCodeImages, useImageDrop } from './codeImages'
import { AddImagesButton, ImageChips, PromptImages } from './ImageAttachments'
import { codeQueue, useCodeQueue } from './queueStore'
import type { CodeJob } from './threads'

/** Cancel: while the job runs on a computer that lets Anemo stop jobs (`cancel`; it needs no control, §12.5). */
export function CancelJobButton({ job }: { job: CodeJob }) {
  const cancel = useCancelJob()
  const waiting = useThreadMessages(job.id).filter((m) => isWaiting(m) && m.state !== 'held')
  if (job.state !== 'running' || !job.device.cancel) return null
  const run = async () => {
    // Messages waiting for this job go out when it stops: say so before it does.
    const stops = t('Claude Code stops on {device}. What it changed so far stays.', { device: job.device.name })
    const ok = await confirmDialog({
      title: t('Cancel this job?'),
      message: waiting.length ? `${stops} ${t('Your queued message is then sent as a follow-up; remove it first to only stop.')}` : stops,
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

/** What a waiting message's card says about it. */
function stateLine(message: CodeMessage): string {
  if (message.state === 'held') return message.note ?? t('This message wasn’t sent.')
  if (message.state === 'sending') return t('Sending…')
  if (message.state === 'sent') {
    return message.mode === 'now' ? t('Sending now: Claude Code stops its current step…') : t('Queued: Claude Code takes it in after its current step')
  }
  return message.note ?? t('Queued: sent after Claude Code’s current step')
}

/** A message waiting for the running job, or held because it couldn't be sent by itself. */
function MessageCard({ message, canSend, busy, onSend, onEdit, onRemove }: {
  message: CodeMessage; canSend: boolean; busy: boolean; onSend: () => void; onEdit: () => void; onRemove: () => void
}) {
  const held = message.state === 'held'
  const sending = message.state === 'sending' || busy
  return (
    <div data-testid="queued-message" className="mb-2 rounded-lg bg-surface-2 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={cn('flex min-w-[min(100%,14rem)] flex-1 items-center gap-1.5 text-[12px] font-medium', held ? 'text-warning' : 'text-muted')}>
          {held ? <TriangleAlert aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            : sending ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin" />
              : <Clock aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />}
          <span className="min-w-0">{stateLine(message)}</span>
        </span>
        {!sending && (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {canSend && (message.mode !== 'now' || held) && (
              <Button size="sm" variant={held ? 'primary' : 'ghost'} icon={<Zap className="h-3.5 w-3.5" />} onClick={onSend}
                title={held ? t('Send it as a follow-up now') : t('Stop Claude Code’s current step and send this now')}>
                {t('Send now')}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onEdit}>{t('Edit')}</Button>
            <Button size="sm" variant="ghost" onClick={onRemove}>{held ? t('Discard message') : t('Remove')}</Button>
          </span>
        )}
      </div>
      <p className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-[13px] [overflow-wrap:anywhere] max-sm:max-h-10">{message.prompt}</p>
      <PromptImages images={message.images ?? []} className="mt-1.5" />
    </div>
  )
}

const NO_IMAGES: CodeImage[] = []
const refuse = (message: string) => toast({ message })

/**
 * The box under a thread, which looks and takes keys like the chat's message box: one
 * line that grows with the text, the round button at its right end, Enter to send and
 * Shift+Enter for a new line (on a touch screen Enter adds a line). After the last job has
 * ended (with a session to resume, on a computer that lets Anemo start jobs) it sends a
 * follow-up. While the job runs it sends a message for the job (§15): queued, Claude Code
 * takes it in after its current step; or, with "Send now", at once, stopping that step. A
 * job that can't take messages gets it as its next follow-up (the server sends it when the
 * job ends). Images can be added with the button, dropped or pasted; they wait with the text
 * as the draft. The thread's waiting messages are shown over the box, to send now, edit or
 * remove. `onSent`: a message was sent or queued (the thread goes to its end, where it shows).
 */
export function FollowUpBox({ job, onSent }: { job: CodeJob; title?: string | null; onSent?: () => void }) {
  const followUp = useFollowUp(job.id)
  const message = useSendMessage(job.id)
  const remove = useRemoveMessage()
  const now = useSendMessageNow()
  const threadId = job.thread_id || job.id
  const waiting = useThreadMessages(job.id).filter(isWaiting)
  // The draft lives in this browser: it survives opening another thread and a reload.
  const text = useCodeQueue((s) => s.drafts[threadId] ?? '')
  const setText = (next: string) => codeQueue.setDraft(threadId, next)
  // The images wait with the text, as uploaded attachments (their ids).
  const draftImages = useCodeQueue((s) => s.draftImages?.[threadId] ?? NO_IMAGES)
  const setDraftImages = useCallback((update: (images: CodeImage[]) => CodeImage[]) => codeQueue.setDraftImages(threadId, update), [threadId])
  const images = useCodeImages({ images: draftImages, setImages: setDraftImages, onRefused: refuse })
  const pending = followUp.isPending || message.isPending
  const drop = useImageDrop(images.add, pending)
  const field = useRef<HTMLTextAreaElement>(null)
  useAutosize(field, text, 240)
  // Touch screens: the on-screen keyboard's Enter adds a line, as in the chat.
  const touch = useMediaQuery('(pointer: coarse)')
  const running = job.state === 'running'
  const canStart = job.device.online && job.device.start

  // Sent as typed; only a blank one is refused.
  const blank = text.trim() === ''
  const sendable = !running && Boolean(job.session_id) && canStart
  // Back into the box (in front of what is there), where it is kept as the draft: taken
  // back from the job first, so it isn't delivered meanwhile.
  const edit = (m: CodeMessage) => {
    remove.mutate(m.id, {
      onSuccess: () => {
        setText(text.trim() ? `${m.prompt}\n\n${text}` : m.prompt)
        if (m.images?.length) setDraftImages((list) => [...(m.images ?? []).map((i) => ({ id: i.id, name: i.name, size: 0 })), ...list].slice(0, MAX_IMAGES))
        field.current?.focus()
      },
      onError: (err) => toast({ message: errorMessage(err) }),
    })
  }
  const drop1 = (m: CodeMessage) => remove.mutate(m.id, {
    onSuccess: () => toast({ message: m.state === 'held' ? t('Message discarded') : t('Queued message removed') }),
    onError: (err) => toast({ message: errorMessage(err) }),
  })
  const sendNow = (m: CodeMessage) => {
    onSent?.()
    now.mutate(m.id, { onError: (err) => toast({ message: startErrorMessage(err) }) })
  }
  const busyId = (remove.isPending ? remove.variables : null) ?? (now.isPending ? now.variables : null)
  const cards = waiting.length > 0 && (
    <div data-testid="queued-messages">
      {waiting.map((m) => (
        <MessageCard key={m.id} message={m} busy={busyId === m.id}
          canSend={m.state === 'held' ? Boolean(job.session_id) && canStart : running ? job.device.cancel : canStart}
          onSend={() => sendNow(m)} onEdit={() => edit(m)} onRemove={() => drop1(m)} />
      ))}
    </div>
  )

  if (running ? !job.device.start : !sendable) {
    // Nothing can be sent from here; messages that wait are still shown, to copy or drop.
    const why = running ? null
      : !job.session_id ? t('This job left no session to continue: start a new job to try again.')
      : !job.device.online
        ? t('{device} is offline: a follow-up can be sent once it is back.', { device: job.device.name })
        : t('{device} doesn’t let Anemo start Claude Code jobs: turn on “Let Anemo start Claude Code jobs” in Anemo Desktop to send a follow-up.', { device: job.device.name })
    if (!why && !cards) return null
    return (
      <Dock>
        {cards}
        {why && <p data-testid="follow-up-off" className="px-1 text-[12.5px] text-muted">{why}</p>}
      </Dock>
    )
  }

  // Sent (or queued) with its images; the box is empty again after.
  const cleared = () => {
    setText('')
    setDraftImages(() => [])
    images.clearFailed()
    onSent?.()
  }
  const submit = (urgent = false) => {
    if (blank || pending || images.uploading) return
    if (running) {
      message.mutate({ prompt: text, images: draftImages, now: urgent }, {
        onSuccess: cleared,
        onError: (err) => toast({ message: startErrorMessage(err) }),
      })
      return
    }
    followUp.mutate({ prompt: text, images: draftImages }, {
      onSuccess: cleared,
      onError: (err) => toast({ message: startErrorMessage(err) }),
    })
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (matchesShortcut(SHORTCUTS['chat.send'], e) && !touch && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }
  const sendLabel = running ? t('Queue message') : t('Send')
  const spinner = <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
  return (
    <Dock>
      {cards}
      {/* The images over the text; the image button, the text and the send button on one line
          (as the text grows the buttons stay at the bottom). Images can also be dropped on the
          box or pasted into the text. */}
      <form className={cn(MESSAGE_BOX, drop.dragging ? 'border-accent bg-accent-soft' : MESSAGE_BOX_BORDER)} {...drop.box}
        onSubmit={(e) => { e.preventDefault(); submit() }}>
        <ImageChips images={draftImages} pending={images.pending} onRemove={images.remove} className="px-1 pb-1.5 pt-0.5" />
        <div className="flex items-end gap-1">
          <AddImagesButton onFiles={images.add} count={images.count} disabled={pending} />
          <textarea ref={field} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} onPaste={drop.onPaste} rows={1} maxLength={100_000}
            aria-label={running ? t('Message for this job') : t('Follow-up')}
            placeholder={drop.dragging ? t('Drop images to add them') : running ? t('Queue a message for this job…') : t('Ask for more in the same session…')}
            readOnly={pending}
            className={cn(MESSAGE_TEXT, 'px-1.5 read-only:opacity-60')} />
          {running && job.device.cancel && (
            <button type="button" onClick={() => submit(true)} disabled={blank || pending || images.uploading}
              aria-label={t('Send now')} title={t('Send now: stop Claude Code’s current step and send this at once')}
              className="mb-0.5 inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-2.5 text-[12.5px] font-medium text-muted hover:bg-surface-hover hover:text-text disabled:pointer-events-none disabled:opacity-40 pointer-coarse:h-10">
              <Zap aria-hidden="true" className="h-3.5 w-3.5" /><span className="max-sm:hidden">{t('Send now')}</span>
            </button>
          )}
          <SendButton type="submit" label={sendLabel} title={images.uploading ? t('Waiting for the images to upload…') : running ? t('Queue: Claude Code takes it in after its current step') : sendLabel} quiet={running}
            disabled={blank || pending || images.uploading}
            icon={pending ? spinner : running ? <ListPlus className="h-4 w-4" /> : undefined} />
        </div>
      </form>
    </Dock>
  )
}

/** The strip under the thread's scrolling part, as wide as the thread. */
function Dock({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useToastLift(ref)
  return <div ref={ref} className="mx-auto w-full max-w-3xl px-3 pb-2 pt-1 md:px-8 md:pb-3">{children}</div>
}
