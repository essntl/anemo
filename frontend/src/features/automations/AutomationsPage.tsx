/**
 * Automations: prompts an agent runs by itself on a schedule. Each card shows
 * when it runs next and how the last run went; its history lists past runs.
 */
import { useState } from 'react'
import { Link } from 'react-router'
import { ChevronDown, Clock, History, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { ActionMenu } from '@/components/ui/ActionMenu'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { confirmDialog } from '@/components/ui/dialogs'
import { EmptyState } from '@/components/ui/EmptyState'
import { Switch } from '@/components/ui/Switch'
import { RunStatusBadge } from '@/features/runs/components/RunStatusBadge'
import { cn } from '@/lib/cn'
import { formatDuration, formatUpcoming, formatWhen } from '@/lib/format'
import {
  type Automation,
  STATUS_LABELS,
  useAutomationRuns,
  useAutomations,
  useDeleteAutomation,
  useRunAutomation,
  useSetAutomationEnabled,
} from './api'
import { AutomationDialog } from './components/AutomationDialog'
import { Lingering } from '@/components/ui/Lingering'

const STATUS_TONES: Record<string, 'neutral' | 'accent' | 'success' | 'warning' | 'error'> = {
  running: 'accent',
  waiting: 'warning',
  paused: 'warning',
  completed: 'success',
  failed: 'error',
  retrying: 'warning',
  missed: 'warning',
}

/** The past runs of one automation; each opens its conversation. */
function RunHistory({ automation }: { automation: Automation }) {
  const runs = useAutomationRuns(automation.id)
  if (runs.isError) return <p className="text-[12.5px] text-error">{errorMessage(runs.error)}</p>
  if (!runs.data) return <p className="text-[12.5px] text-muted">Loading…</p>
  if (runs.data.length === 0) return <p className="text-[12.5px] text-muted">It has not run yet.</p>
  return (
    <ul className="flex flex-col">
      {runs.data.map((run) => (
        <li key={run.id}>
          <Link to={run.conversation_id ? `/c/${run.conversation_id}` : `/runs/${run.id}`}
            className="flex items-center gap-2 rounded-control px-2 py-1.5 text-[13px] hover:bg-surface-hover pointer-coarse:py-2.5">
            <span className="w-32 shrink-0 text-muted">{formatWhen(run.created_at)}</span>
            <RunStatusBadge status={run.status} />
            <span className="min-w-0 flex-1 truncate text-right text-[12px] text-subtle">
              {run.totals.tool_calls} action{run.totals.tool_calls === 1 ? '' : 's'}
              {run.totals.active_s > 0 && <> · {formatDuration(run.totals.active_s)}</>}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

function AutomationCard({ automation, onEdit }: { automation: Automation; onEdit: () => void }) {
  const setEnabled = useSetAutomationEnabled()
  const runNow = useRunAutomation()
  const remove = useDeleteAutomation()
  const [showHistory, setShowHistory] = useState(false)
  const running = automation.active_run_id !== null
  const status = automation.last_status
  const error = setEnabled.error ?? runNow.error ?? remove.error

  const confirmDelete = async () => {
    const ok = await confirmDialog({
      title: `Delete “${automation.name}”?`,
      message: 'The automation and the conversations of its past runs are deleted. Documents and files it made are kept.',
      confirmLabel: 'Delete',
      danger: true,
    })
    if (ok) remove.mutate(automation.id)
  }

  return (
    <div className={cn('rounded-card border border-border bg-card px-4 py-3 shadow-soft', !automation.enabled && 'opacity-80')}>
      <div className="flex items-start gap-3">
        <div className="pt-1">
          <Switch label={`Run “${automation.name}” on schedule`} checked={automation.enabled}
            onChange={(enabled) => setEnabled.mutate({ id: automation.id, enabled })} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="min-w-0 break-words text-[15px] font-semibold">{automation.name}</h2>
            {status && <Badge tone={STATUS_TONES[status] ?? 'neutral'}>{STATUS_LABELS[status] ?? status}</Badge>}
          </div>
          <p className="mt-0.5 text-[13px] text-muted">
            {automation.schedule_text}
            {automation.enabled && automation.next_run_at && <> · next {formatUpcoming(automation.next_run_at)}</>}
            {!automation.enabled && <> · off</>}
            {automation.last_run_at && <> · last ran {formatWhen(automation.last_run_at)}</>}
          </p>
          <p className="mt-1.5 line-clamp-2 whitespace-pre-wrap break-words text-[13px] text-subtle">{automation.prompt}</p>
        </div>
        <ActionMenu actions={[
          { label: 'Edit', icon: <Pencil />, onSelect: onEdit },
          { label: 'Delete', icon: <Trash2 />, danger: true, onSelect: () => void confirmDelete() },
        ]} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 pl-12">
        <Button size="sm" variant="secondary" icon={<Play className="h-3.5 w-3.5" />} disabled={running}
          loading={runNow.isPending} onClick={() => runNow.mutate(automation.id)}>
          Run now
        </Button>
        <Button size="sm" variant="ghost" aria-expanded={showHistory} onClick={() => setShowHistory(!showHistory)}
          icon={<History className="h-3.5 w-3.5" />}>
          History
          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', showHistory && 'rotate-180')} />
        </Button>
        {running && automation.active_run_id && (
          <Link to={`/runs/${automation.active_run_id}`} className="text-[13px] text-accent hover:underline">
            {status === 'waiting' ? 'Review and approve' : 'Watch it work'}
          </Link>
        )}
      </div>
      {error && <p className="mt-2 pl-12 text-[12.5px] text-error">{errorMessage(error)}</p>}
      {showHistory && <div className="mt-2 border-t border-border pt-2 md:pl-10"><RunHistory automation={automation} /></div>}
    </div>
  )
}

export function AutomationsPage() {
  const automations = useAutomations()
  // null: closed. { automation: null }: creating one.
  const [editing, setEditing] = useState<{ automation: Automation | null } | null>(null)
  const items = automations.data ?? []

  return (
    <div className="mx-auto max-w-3xl p-4 md:p-8">
      <div className="mb-5 flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Clock className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold">Automations</h1>
          <p className="text-[13px] text-muted">
            Things an agent does by itself on a schedule, and reports back as a{' '}
            <Link to="/notifications" className="text-accent underline">notification</Link>.
          </p>
        </div>
        <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({ automation: null })}>
          New
        </Button>
      </div>

      {automations.isError && <p className="text-[13px] text-error">{errorMessage(automations.error)}</p>}
      {automations.isSuccess && items.length === 0 && (
        <EmptyState icon={<Clock className="h-5 w-5" />} title="No automations yet"
          description="For example: a news briefing every morning, a weekly summary of your open tasks, or a check that tells you when a web page changes."
          action={<Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({ automation: null })}>New automation</Button>} />
      )}
      <div className="flex flex-col gap-2">
        {items.map((a) => <AutomationCard key={a.id} automation={a} onEdit={() => setEditing({ automation: a })} />)}
      </div>

      <Lingering value={editing}>{(shown) => <AutomationDialog automation={shown.automation} onClose={() => setEditing(null)} />}</Lingering>
    </div>
  )
}
