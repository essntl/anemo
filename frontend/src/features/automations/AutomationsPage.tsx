/**
 * Automations: prompts an agent runs by itself on a schedule. Each card shows
 * when it runs next and how the last run went; its history (the run log) lists past
 * runs with their outcome and what they changed. `?automation=<id>&run=<run id>` opens
 * that automation's run log at that run (links to what an automation did).
 */
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ChevronDown, Clock, History, Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { ActionMenu } from '@/components/ui/ActionMenu'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { confirmDialog } from '@/components/ui/dialogs'
import { EmptyState } from '@/components/ui/EmptyState'
import { Switch } from '@/components/ui/Switch'
import { RunStatusBadge } from '@/features/runs/components/RunStatusBadge'
import { useSaveSection, useSettings } from '@/features/settings/api'
import { cn } from '@/lib/cn'
import { formatUpcoming, formatWhen } from '@/lib/format'
import { plural, rich, t } from '@/lib/i18n'
import {
  type Automation,
  type AutomationRun,
  STATUS_LABELS,
  useAutomationRuns,
  useAutomations,
  useDeleteAutomation,
  useRunAutomation,
  useSetAutomationEnabled,
} from './api'
import { AutomationDialog } from './components/AutomationDialog'
import { type AutomationTemplate, TEMPLATES } from './templates'
import { Lingering } from '@/components/ui/Lingering'
import { PageHeader } from '@/components/ui/PageHeader'

const STATUS_TONES: Record<string, 'neutral' | 'accent' | 'success' | 'warning' | 'error'> = {
  running: 'accent',
  waiting: 'warning',
  paused: 'warning',
  completed: 'success',
  failed: 'error',
  retrying: 'warning',
  missed: 'warning',
}

/** One run in the log: when, how it went, the model's outcome line and the changes the
 * server recorded from its tool calls. */
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

/** The run log of one automation; each run opens its conversation. */
function RunHistory({ automation, highlight }: { automation: Automation; highlight: string | null }) {
  const runs = useAutomationRuns(automation.id)
  if (runs.isError) return <p className="text-[12.5px] text-error">{errorMessage(runs.error)}</p>
  if (!runs.data) return <p className="text-[12.5px] text-muted">{t('Loading…')}</p>
  if (runs.data.length === 0) return <p className="text-[12.5px] text-muted">{t('It has not run yet.')}</p>
  return (
    <ul className="flex flex-col">
      {runs.data.map((run) => <RunLogEntry key={run.run_id} run={run} highlighted={run.run_id === highlight} />)}
    </ul>
  )
}

function AutomationCard({ automation, onEdit, highlight }: { automation: Automation; onEdit: () => void; highlight?: string | null }) {
  const setEnabled = useSetAutomationEnabled()
  const runNow = useRunAutomation()
  const remove = useDeleteAutomation()
  // `highlight` is set when a link pointed here (undefined: none did).
  const [showHistory, setShowHistory] = useState(highlight !== undefined)
  const pending = automation.pending_approvals ?? []
  const running = automation.active_run_id !== null
  const status = automation.last_status
  const error = setEnabled.error ?? runNow.error ?? remove.error

  const confirmDelete = async () => {
    const ok = await confirmDialog({
      title: t('Delete “{name}”?', { name: automation.name }),
      message: t('The automation and the conversations of its past runs are deleted. Documents and files it made are kept.'),
      confirmLabel: t('Delete'),
      danger: true,
    })
    if (ok) remove.mutate(automation.id)
  }

  return (
    <div className={cn('rounded-card border border-border bg-card px-4 py-3 shadow-soft', !automation.enabled && 'opacity-80')}>
      <div className="flex items-start gap-3">
        <div className="pt-1">
          <Switch label={t('Run “{name}” on schedule', { name: automation.name })} checked={automation.enabled}
            onChange={(enabled) => setEnabled.mutate({ id: automation.id, enabled })} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="min-w-0 break-words text-[15px] font-semibold">{automation.name}</h2>
            {status && <Badge tone={STATUS_TONES[status] ?? 'neutral'}>{t(STATUS_LABELS[status] ?? status)}</Badge>}
            {automation.created_by === 'agent' && <Badge tone="neutral">{t('Set up by the assistant')}</Badge>}
          </div>
          <p className="mt-0.5 text-[13px] text-muted">
            {automation.schedule_text}
            {automation.enabled && automation.next_run_at && <> · {t('next {when}', { when: formatUpcoming(automation.next_run_at) })}</>}
            {!automation.enabled && <> · {t('off')}</>}
            {automation.last_run_at && <> · {t('last ran {when}', { when: formatWhen(automation.last_run_at) })}</>}
          </p>
          <p className="mt-1.5 line-clamp-2 whitespace-pre-wrap break-words text-[13px] text-subtle">{automation.prompt}</p>
          {(automation.failure_streak ?? 0) > 0 && automation.last_error && (
            <p className="mt-1.5 break-words text-[12.5px] text-error">
              {plural(automation.failure_streak ?? 0, 'Failed {n} time in a row: {error}', 'Failed {n} times in a row: {error}', { error: automation.last_error })}
            </p>
          )}
        </div>
        <ActionMenu actions={[
          { label: t('Edit'), icon: <Pencil />, onSelect: onEdit },
          { label: t('Delete'), icon: <Trash2 />, danger: true, onSelect: () => void confirmDelete() },
        ]} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 pl-12">
        <Button size="sm" variant="secondary" icon={<Play className="h-3.5 w-3.5" />} disabled={running}
          loading={runNow.isPending} onClick={() => runNow.mutate(automation.id)}>
          {t('Run now')}
        </Button>
        <Button size="sm" variant="ghost" aria-expanded={showHistory} onClick={() => setShowHistory(!showHistory)}
          icon={<History className="h-3.5 w-3.5" />}>
          {t('History')}
          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', showHistory && 'rotate-180')} />
        </Button>
        {running && automation.active_run_id && status !== 'waiting' && (
          <Link to={`/runs/${automation.active_run_id}`} className="text-[13px] text-accent hover:underline">
            {t('Watch it work')}
          </Link>
        )}
        {pending.length > 0 && (
          <Link to={pending[0].conversation_id ? `/c/${pending[0].conversation_id}` : `/runs/${pending[0].run_id}`}
            className="text-[13px] text-accent hover:underline">
            {pending.length === 1 ? t('Review and approve') : plural(pending.length, '{n} approval waiting', '{n} approvals waiting')}
          </Link>
        )}
      </div>
      {error && <p className="mt-2 pl-12 text-[12.5px] text-error">{errorMessage(error)}</p>}
      {showHistory && <div className="mt-2 border-t border-border pt-2 md:pl-10"><RunHistory automation={automation} highlight={highlight ?? null} /></div>}
    </div>
  )
}

export function AutomationsPage() {
  const automations = useAutomations()
  // null: closed. { automation: null }: creating one.
  const [editing, setEditing] = useState<{ automation: Automation | null; template?: AutomationTemplate } | null>(null)
  const settings = useSettings()
  const saveProtections = useSaveSection('automations')
  const [params] = useSearchParams()
  const linked = params.get('automation')
  const protections = settings.data?.automations
  const paused = protections?.paused ?? false
  const items = automations.data ?? []
  const templates = TEMPLATES.filter((tpl) => !items.some((a) => a.name === tpl.name || a.name === t(tpl.name)))

  return (
    <div className="mx-auto max-w-3xl p-4 md:px-8 md:pb-8 md:pt-2">
      <PageHeader title={t('Automations')}>
        <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({ automation: null })}>
          {/* "New" is also said of other things (a document): the empty {automation} keeps this translation apart. */}
          {t('New##automation')}
        </Button>
      </PageHeader>
      <p className="mb-4 max-w-2xl text-[13px] text-muted">
        {rich('Things an agent does by itself on a schedule, and reports back as a <a>notification</a>.', { a: (c) => <Link to="/notifications" className="text-accent underline">{c}</Link> })}
        </p>

      {protections && (items.length > 0 || paused) && (
        <div className={cn('mb-3 flex items-center gap-3 rounded-card border px-4 py-2.5', paused ? 'border-warning bg-surface-2' : 'border-border bg-card')}>
          <Pause className={cn('h-4 w-4 shrink-0', paused ? 'text-warning' : 'text-muted')} />
          <div className="min-w-0 flex-1 text-[13px]">
            <div className="font-medium">{paused ? t('All automations are paused') : t('Pause all automations')}</div>
            <div className="text-muted">
              {paused
                ? t('Nothing starts on a schedule until you resume. A run that is going on finishes.')
                : t('Stops every schedule from starting, without switching them off one by one. A scheduled run is stopped after {minutes} minutes.', { minutes: protections.max_run_minutes })}
            </div>
          </div>
          <Switch label={t('Pause all automations')} checked={paused}
            onChange={(next) => saveProtections.mutate({ ...protections, paused: next })} />
        </div>
      )}
      {saveProtections.isError && <p className="mb-2 text-[13px] text-error">{errorMessage(saveProtections.error)}</p>}
      {automations.isError && <p className="text-[13px] text-error">{errorMessage(automations.error)}</p>}
      {automations.isSuccess && items.length === 0 && (
        <EmptyState icon={<Clock className="h-5 w-5" />} title={t('No automations yet')}
          description={t('For example: a news briefing every morning, a weekly summary of your open tasks, or a check that tells you when a web page changes.')}
          action={<Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({ automation: null })}>{t('New automation')}</Button>} />
      )}
      <div className="flex flex-col gap-2">
        {items.map((a) => (
          <AutomationCard key={a.id} automation={a} onEdit={() => setEditing({ automation: a })}
            highlight={a.id === linked ? params.get('run') : undefined} />
        ))}
      </div>

      {automations.isSuccess && templates.length > 0 && (
        <section className="mt-6" aria-label={t('Templates')}>
          <h2 className="mb-2 text-[13px] font-semibold text-muted">{t('Start from a template')}</h2>
          <div className="flex flex-wrap gap-2">
            {templates.map((tpl) => (
              <Button key={tpl.name} variant="secondary" size="sm" onClick={() => setEditing({ automation: null, template: { ...tpl, name: t(tpl.name), prompt: t(tpl.prompt) } })}>{t(tpl.name)}</Button>
            ))}
          </div>
        </section>
      )}

      <Lingering value={editing}>{(shown) => <AutomationDialog automation={shown.automation} template={shown.template} onClose={() => setEditing(null)} />}</Lingering>
    </div>
  )
}
