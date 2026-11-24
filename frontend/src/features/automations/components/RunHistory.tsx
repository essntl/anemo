/** An automation's run log: its past runs with their outcome, what they changed and how
 * long they took (shown as the chat shows an answer's duration). Shared by agent
 * automations and scripts. */
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { errorMessage } from '@/api/client'
import { Badge } from '@/components/ui/Badge'
import { AnswerDuration, LiveTiming } from '@/features/chat/components/AnswerTiming'
import { RunStatusBadge } from '@/features/runs/components/RunStatusBadge'
import { cn } from '@/lib/cn'
import { formatWhen } from '@/lib/format'
import { plural, t } from '@/lib/i18n'
import { type Automation, type AutomationRun, useAutomationRun, useAutomationRuns } from '../api'


/** How long a run took, quietly, with the details on hover or click (as in the chat);
 * counting up while it works, standing still while it waits for you. */
function RunDuration({ run }: { run: AutomationRun }) {
  const { timing } = run
  return (
    <span className="shrink-0 text-[12px] text-muted">
      {timing.finished_at ? <AnswerDuration timing={timing} label={t('How long the run took:')} /> : <LiveTiming timing={timing} paused={run.status === 'paused'} />}
    </span>
  )
}

/** One run in the log: when, how it went, how long it took, the model's outcome line
 * and the changes the server recorded from its tool calls. */
function RunLogEntry({ run, highlighted }: { run: AutomationRun; highlighted: boolean }) {
  const ref = useRef<HTMLLIElement>(null)
  const [open, setOpen] = useState(highlighted)
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView?.({ block: 'center' })
  }, [highlighted])
  const changes = run.changes ?? []
  const summary = run.error ?? run.outcome_line
  return (
    <li ref={ref} className={cn('rounded-control', highlighted && 'bg-surface-2')}>
      <div className="flex flex-wrap items-center gap-2 px-2 py-1.5 text-[13px] pointer-coarse:py-2.5">
        <Link to={run.conversation_id ? `/c/${run.conversation_id}` : `/runs/${run.run_id}`}
          className="w-32 shrink-0 text-muted hover:underline">{formatWhen(run.created_at)}</Link>
        <RunStatusBadge status={run.status} />
        <RunDuration run={run} />
        {run.nothing_to_do && <Badge tone="neutral">{t('Nothing to do')}</Badge>}
        <span className={cn('min-w-0 flex-1 truncate text-[12.5px]', run.error ? 'text-error' : 'text-subtle')} title={summary ?? undefined}>
          {summary}
        </span>
        {changes.length > 0 && (
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
            className="text-[12px] text-accent hover:underline">
            {plural(changes.length, '{n} change', '{n} changes')}
          </button>
        )}
      </div>
      {open && changes.length > 0 && (
        <ul className="mb-1.5 ml-36 flex flex-col gap-0.5 text-[12.5px] text-muted max-md:ml-4">
          {changes.map((c, i) => (
            <li key={i} className="min-w-0 truncate">
              <span className="font-mono text-[11.5px] text-subtle">{c.tool}</span>{' '}
              {c.ref ? <Link to={c.ref} className="text-accent hover:underline">{c.summary}</Link> : c.summary}
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

/** The run log of one automation; each run opens its conversation. A run a link points
 * to that is older than the log shows is fetched on its own and shown first. */
export function RunHistory({ automation, highlight }: { automation: Automation; highlight: string | null }) {
  const runs = useAutomationRuns(automation.id, [automation.active_run_id, automation.last_status, automation.last_run_at].join('|'))
  const listed = runs.data?.some((run) => run.run_id === highlight) ?? true
  const linked = useAutomationRun(automation.id, highlight && !listed ? highlight : null)
  if (runs.isError) return <p className="text-[12.5px] text-error">{errorMessage(runs.error)}</p>
  if (!runs.data) return <p className="text-[12.5px] text-muted">{t('Loading…')}</p>
  const older = listed ? [] : (linked.data ?? [])
  if (runs.data.length === 0 && older.length === 0) return <p className="text-[12.5px] text-muted">{t('It has not run yet.')}</p>
  return (
    <ul className="flex flex-col">
      {older.map((run) => <RunLogEntry key={run.run_id} run={run} highlighted />)}
      {runs.data.map((run) => <RunLogEntry key={run.run_id} run={run} highlighted={run.run_id === highlight} />)}
    </ul>
  )
}
