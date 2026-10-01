/**
 * Run history: every agent run (and optionally chat turns), newest first,
 * with filters. The filters live in the URL so a view can be reloaded or linked.
 */
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Bot, History, Search } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Select } from '@/components/ui/Select'
import { formatCost, formatDuration, formatWhen } from '@/lib/format'
import { type RunKindFilter, type RunListItem, type RunStatusFilter, useRuns } from '../api'
import { RunStatusBadge } from '../components/RunStatusBadge'

const STATUS_OPTIONS: { value: RunStatusFilter; label: string }[] = [
  { value: 'all', label: 'Any status' },
  { value: 'active', label: 'Running' },
  { value: 'waiting', label: 'Needs you or paused' },
  { value: 'completed', label: 'Done' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
]
const KIND_OPTIONS: { value: RunKindFilter; label: string }[] = [
  { value: 'agent', label: 'Agent runs' },
  { value: 'chat', label: 'Chat answers' },
  { value: 'all', label: 'Everything' },
]

function RunRow({ run }: { run: RunListItem }) {
  const who = run.profile_name ?? (run.kind === 'agent' ? 'Default agent' : 'Chat')
  const meta = [run.automation_id ? 'Automation' : null, who, run.conversation_title, run.model_label]
    .filter(Boolean)
    .join(' · ')
  return (
    <Link to={`/runs/${run.id}`}
      className="flex items-start gap-3 rounded-card border border-border bg-card px-4 py-3 shadow-soft transition-colors hover:border-border-strong hover:bg-surface-hover">
      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 break-words text-[14px] font-medium">{run.request || '(no request)'}</div>
        <div className="mt-1 flex min-w-0 items-center gap-2">
          <RunStatusBadge status={run.status} />
          <span className="min-w-0 truncate text-[12px] text-muted">{meta}</span>
        </div>
      </div>
      <div className="shrink-0 text-right text-[12px] text-muted">
        <div>{formatWhen(run.created_at)}</div>
        {run.kind === 'agent' && (
          <div className="text-subtle">
            {run.totals.tool_calls} action{run.totals.tool_calls === 1 ? '' : 's'}
            {run.totals.active_s > 0 && <> · {formatDuration(run.totals.active_s)}</>}
            {run.totals.cost_usd != null && <> · {formatCost(run.totals.cost_usd)}</>}
          </div>
        )}
      </div>
    </Link>
  )
}

export function RunsPage() {
  const [params, setParams] = useSearchParams()
  const status = (params.get('status') ?? 'all') as RunStatusFilter
  const kind = (params.get('kind') ?? 'agent') as RunKindFilter
  const [query, setQuery] = useState(params.get('q') ?? '')
  const q = params.get('q') ?? ''
  const runs = useRuns({ status, kind, q })
  const items = runs.data?.pages.flat() ?? []

  const setParam = (key: string, value: string, fallback: string) => {
    const next = new URLSearchParams(params)
    if (value === fallback) next.delete(key)
    else next.set(key, value)
    setParams(next, { replace: true })
  }

  return (
    <div className="mx-auto max-w-4xl p-4 md:p-8">
      <div className="mb-5 flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <History className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-xl font-semibold">Runs</h1>
          <p className="text-[13px] text-muted">What your agents did: every step, tool call, approval and file change.</p>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <form className="relative min-w-48 flex-1" onSubmit={(e) => { e.preventDefault(); setParam('q', query.trim(), '') }}>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} onBlur={() => setParam('q', query.trim(), '')}
            placeholder="Search requests" aria-label="Search requests"
            className="h-10 w-full rounded-control border border-border bg-surface pl-9 pr-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft" />
        </form>
        <Select className="w-full sm:w-52" aria-label="Status" value={status} options={STATUS_OPTIONS}
          onValueChange={(v) => setParam('status', v, 'all')} />
        <Select className="w-full sm:w-44" aria-label="Kind" value={kind} options={KIND_OPTIONS}
          onValueChange={(v) => setParam('kind', v, 'agent')} />
      </div>

      {runs.isError && <p className="text-[13px] text-error">{errorMessage(runs.error)}</p>}
      {runs.isSuccess && items.length === 0 && (
        <EmptyState icon={<Bot className="h-5 w-5" />} title="No runs here"
          description={status === 'all' && !q ? 'Switch a chat to Agent mode and give it a task: its runs show up here.' : 'Nothing matches these filters.'} />
      )}
      <div className="flex flex-col gap-2">
        {items.map((run) => <RunRow key={run.id} run={run} />)}
      </div>
      {runs.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button variant="secondary" loading={runs.isFetchingNextPage} onClick={() => void runs.fetchNextPage()}>
            Load more
          </Button>
        </div>
      )}
    </div>
  )
}
