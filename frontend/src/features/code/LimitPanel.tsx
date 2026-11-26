/**
 * "Limit reached" (docs/specs/code-sessions.md §16): a job that stopped at the Claude
 * subscription's usage limit says when the limit resets, and, for the thread's last job, has
 * the Auto continue switch: on, the server resumes the session a few minutes after the reset
 * (as soon as the computer is back), so its context and prompt cache are reused.
 */
import { Hourglass } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Switch } from '@/components/ui/Switch'
import { toast } from '@/components/ui/toast'
import { formatUpcoming } from '@/lib/format'
import { t } from '@/lib/i18n'
import { useAutoContinue } from './api'
import type { CodeJob } from './threads'

/** What the panel says about the continue, or null when there is nothing to say. */
function statusLine(job: CodeJob): string | null {
  switch (job.resume_state) {
    case 'scheduled': {
      const when = job.resume_at ? t('Continues by itself {when}, in the same session.', { when: formatUpcoming(job.resume_at) }) : t('Continues by itself, in the same session.')
      return job.device.online ? when : `${when} ${t('{device} is offline: it continues as soon as it is back.', { device: job.device.name })}`
    }
    case 'starting':
      return t('Continuing…')
    case 'started':
      return t('Continued in the next job of this thread.')
    case 'cancelled':
    case 'stopped':
    case 'failed':
      return job.resume_note ?? null
    default:
      return null
  }
}

export function LimitPanel({ job, last }: { job: CodeJob; last: boolean }) {
  const toggle = useAutoContinue()
  if (!job.limit_hit || job.state === 'running' || job.state === 'cancelled') return null
  const on = job.resume_state === 'scheduled' || job.resume_state === 'starting'
  const status = statusLine(job)
  const switchable = last && job.resume_state !== 'started' && job.resume_state !== 'starting'
  return (
    <section data-testid="limit-panel" aria-label={t('Limit reached')} className="mx-2 mt-3 rounded-xl border border-warning/40 bg-warning/8 p-3">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-60">
          <div className="flex items-center gap-2 text-[13px] font-semibold">
            <Hourglass aria-hidden="true" className="h-4 w-4 text-warning" />
            {t('Limit reached')}
          </div>
          <p className="mt-1 text-[12.5px] text-muted">
            {job.limit_resets_at ? t('The usage limit resets {when}.', { when: formatUpcoming(job.limit_resets_at) }) : t('When the usage limit resets isn’t known; it is tried again in an hour.')}
          </p>
        </div>
        {switchable && (
          <label className="flex shrink-0 cursor-pointer items-center gap-2 text-[13px] font-medium">
            {t('Auto continue')}
            <Switch label={t('Auto continue')} checked={on} disabled={toggle.isPending}
              onChange={(enabled) => toggle.mutate({ jobId: job.id, enabled }, { onError: (err) => toast({ message: errorMessage(err) }) })} />
          </label>
        )}
      </div>
      {switchable && !on && !status && (
        <p className="mt-2 text-[12px] text-subtle">{t('On, the job resumes its session with “Continue where you left off.” a few minutes after the limit resets, reusing its context.')}</p>
      )}
      {status && <p data-testid="limit-status" className="mt-2 text-[12.5px]">{status}</p>}
    </section>
  )
}
