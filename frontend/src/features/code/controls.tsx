/**
 * Controlling a thread (docs/specs/code-sessions.md §12.4): cancelling the running job,
 * sending a follow-up, and where a job an agent started came from.
 */
import { type KeyboardEvent, useState } from 'react'
import { Link } from 'react-router'
import { MessageSquare, Send, Square } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { confirmDialog } from '@/components/ui/dialogs'
import { Textarea } from '@/components/ui/Input'
import { toast } from '@/components/ui/toast'
import { chatLink } from '@/lib/appLinks'
import { t } from '@/lib/i18n'
import { useCancelJob, useFollowUp } from './api'
import type { CodeJob } from './threads'

/** Cancel: while the job runs on a computer that lets Anemo start (and so stop) jobs. */
export function CancelJobButton({ job }: { job: CodeJob }) {
  const cancel = useCancelJob()
  if (job.state !== 'running' || !job.device.start) return null
  const run = async () => {
    const ok = await confirmDialog({
      title: t('Cancel this job?'),
      message: t('Claude Code stops on {device}. What it changed so far stays.', { device: job.device.name }),
      confirmLabel: t('Cancel job'),
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

/**
 * A follow-up under a thread whose last job has ended and has a session to resume, on a
 * computer that lets Anemo start jobs. Otherwise nothing, or one line saying why.
 */
export function FollowUpBox({ job }: { job: CodeJob }) {
  const followUp = useFollowUp(job.id)
  const [text, setText] = useState('')
  if (job.state === 'running' || !job.session_id) return null
  if (!job.device.online || !job.device.start) {
    return (
      <p data-testid="follow-up-off" className="mx-2 mt-4 text-[12.5px] text-muted">
        {!job.device.online
          ? t('{device} is offline: a follow-up can be sent once it is back.', { device: job.device.name })
          : t('{device} doesn’t let Anemo start Claude Code jobs: turn on “Let Anemo start Claude Code jobs” in Anemo Desktop to send a follow-up.', { device: job.device.name })}
      </p>
    )
  }
  const prompt = text.trim()
  const send = () => {
    if (!prompt || followUp.isPending) return
    followUp.mutate(prompt, {
      onSuccess: () => setText(''),
      onError: (err) => toast({ message: errorMessage(err) }),
    })
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      send()
    }
  }
  return (
    <form className="mx-2 mt-4 rounded-xl border border-border bg-surface p-2" onSubmit={(e) => { e.preventDefault(); send() }}>
      <Textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} rows={3} maxLength={100_000}
        aria-label={t('Follow-up')} placeholder={t('Ask for more in the same session…')} disabled={followUp.isPending}
        className="resize-y border-0 bg-transparent focus:ring-0" />
      <div className="mt-1 flex items-center justify-end gap-2">
        <span className="text-[11.5px] text-subtle max-md:hidden">{t('Ctrl+Enter to send')}</span>
        <Button type="submit" size="sm" variant="primary" icon={<Send className="h-3.5 w-3.5" />} loading={followUp.isPending} disabled={!prompt}>
          {t('Send')}
        </Button>
      </div>
    </form>
  )
}
