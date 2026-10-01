/**
 * Settings > Usage: what the models cost and how much they were used, for a period:
 * totals, a chart per day, a breakdown (by model, kind of work, …) and the single
 * calls. A cost can be unknown (no price set for the model); that is shown as
 * unknown, never as $0.
 */
import { type ReactNode, useState } from 'react'
import { Link } from 'react-router'
import { BarChart3 } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Select } from '@/components/ui/Select'
import { formatCost, formatCount, formatWhen } from '@/lib/format'
import { type GroupBy, type UsageGroup, type UsageTotals, useUsageRecords, useUsageSummary } from './api'
import { type DayBar, DayChart } from './components/DayChart'
import { daysIn, type RangeId, rangeFor, RANGES } from './ranges'

const GROUPINGS: { value: Exclude<GroupBy, 'day'>; label: string }[] = [
  { value: 'model', label: 'By model' },
  { value: 'kind', label: 'By kind of work' },
  { value: 'provider', label: 'By provider' },
  { value: 'profile', label: 'By agent profile' },
  { value: 'automation', label: 'By automation' },
]
const KIND_LABELS: Record<string, string> = {
  chat: 'Chat', agent: 'Agent', title: 'Naming chats', memory: 'Memory', embedding: 'Search index',
  summarize: 'Summaries', test: 'Connection tests',
} // prettier-ignore

type Metric = 'cost' | 'tokens' | 'requests'
const METRICS: { value: Metric; label: string }[] = [
  { value: 'cost', label: 'Cost' },
  { value: 'tokens', label: 'Tokens' },
  { value: 'requests', label: 'Calls' },
]

const valueOf = (t: UsageTotals, metric: Metric) =>
  metric === 'cost' ? t.cost_usd : metric === 'tokens' ? t.input_tokens + t.output_tokens : t.requests
const formatMetric = (metric: Metric) => (value: number) =>
  metric === 'cost' ? formatCost(value) : formatCount(Math.round(value))

/** "$1.20", or "$1.20 + unknown" when some calls have no known cost. */
function Cost({ totals }: { totals: UsageTotals }) {
  if (totals.unknown_cost_requests === totals.requests && totals.requests > 0) return <>unknown</>
  return (
    <>
      {formatCost(totals.cost_usd)}
      {totals.unknown_cost_requests > 0 && <span className="text-muted"> + unknown</span>}
    </>
  )
}

function Stat({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-card border border-border bg-card px-4 py-3 shadow-soft">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-subtle">{label}</div>
      <div className="mt-1 text-[20px] font-semibold tabular-nums">{children}</div>
      {hint && <div className="text-[12px] text-muted">{hint}</div>}
    </div>
  )
}

function Breakdown({ groups, grouping }: { groups: UsageGroup[]; grouping: GroupBy }) {
  if (groups.length === 0) return <p className="text-[13px] text-muted">Nothing in this period.</p>
  const label = (g: UsageGroup) => (grouping === 'kind' ? (KIND_LABELS[g.label] ?? g.label) : g.label)
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[13px]">
        <thead className="text-[11px] uppercase tracking-wider text-subtle">
          <tr>
            <th className="py-1.5 pr-3 font-semibold">{GROUPINGS.find((g) => g.value === grouping)?.label.replace('By ', '')}</th>
            <th className="px-3 py-1.5 text-right font-semibold">Cost</th>
            <th className="px-3 py-1.5 text-right font-semibold">Calls</th>
            <th className="px-3 py-1.5 text-right font-semibold">Tokens in</th>
            <th className="py-1.5 pl-3 text-right font-semibold">Tokens out</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.key} className="border-t border-border">
              <td className="max-w-64 break-words py-2 pr-3 font-medium" title={g.key !== g.label ? g.key : undefined}>{label(g)}</td>
              <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums"><Cost totals={g} /></td>
              <td className="px-3 py-2 text-right tabular-nums">{formatCount(g.requests)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatCount(g.input_tokens)}</td>
              <td className="py-2 pl-3 text-right tabular-nums">{formatCount(g.output_tokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RecentCalls({ range }: { range: ReturnType<typeof rangeFor> }) {
  const records = useUsageRecords(range)
  const rows = records.data?.pages.flat() ?? []
  if (records.isError) return <p className="text-[13px] text-error">{errorMessage(records.error)}</p>
  if (records.isSuccess && rows.length === 0) return <p className="text-[13px] text-muted">No model calls in this period.</p>
  return (
    <>
      <ul className="text-[13px]">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center gap-3 border-t border-border py-2 first:border-t-0">
            <span className="w-24 shrink-0 text-[12px] text-muted sm:w-32">{formatWhen(r.ts)}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{r.model_key}</span>
              <span className="block truncate text-[12px] text-muted">
                {KIND_LABELS[r.request_kind] ?? r.request_kind} · {r.provider_name}
                {r.run_id && <> · <Link to={`/runs/${r.run_id}`} className="text-accent hover:underline">run</Link></>}
              </span>
            </span>
            <span className="shrink-0 text-right tabular-nums">
              <span className="block">{r.cost_usd == null ? 'unknown' : formatCost(r.cost_usd)}</span>
              <span className="block text-[12px] text-muted">
                {r.input_tokens == null ? '?' : formatCount(r.input_tokens)} in · {r.output_tokens == null ? '?' : formatCount(r.output_tokens)} out
              </span>
            </span>
          </li>
        ))}
      </ul>
      {records.hasNextPage && (
        <div className="mt-3 flex justify-center">
          <Button size="sm" variant="secondary" loading={records.isFetchingNextPage} onClick={() => void records.fetchNextPage()}>
            Load more
          </Button>
        </div>
      )}
    </>
  )
}

export function UsagePage() {
  const [rangeId, setRangeId] = useState<RangeId>('30d')
  const [grouping, setGrouping] = useState<Exclude<GroupBy, 'day'>>('model')
  const [metric, setMetric] = useState<Metric>('cost')
  // The period is worked out once per choice ("now" must not change while rendering).
  const [range, setRange] = useState(() => rangeFor('30d'))
  const chooseRange = (id: RangeId) => {
    setRangeId(id)
    setRange(rangeFor(id))
  }

  const byDay = useUsageSummary(range, 'day')
  const breakdown = useUsageSummary(range, grouping)
  const totals = byDay.data?.totals
  const dayGroups = new Map((byDay.data?.groups ?? []).map((g) => [g.key, g]))
  const days = daysIn(range) ?? [...dayGroups.keys()]
  const bars: DayBar[] = days.map((day) => {
    const g = dayGroups.get(day)
    return {
      day,
      value: g ? valueOf(g, metric) : 0,
      detail: g ? `${g.requests} call${g.requests === 1 ? '' : 's'}, ${formatCost(g.cost_usd)}${g.unknown_cost_requests ? ' + unknown' : ''}` : 'nothing',
    }
  })

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <BarChart3 className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">Usage</h2>
          <p className="text-[13px] text-muted">
            Model calls, tokens and cost. Costs are what the provider reported, or worked out from the prices set in{' '}
            <Link to="/settings/providers" className="text-accent underline">Providers & Models</Link>.
          </p>
        </div>
        <Select className="w-full sm:w-44" aria-label="Period" value={rangeId} options={RANGES.map((r) => ({ value: r.id, label: r.label }))}
          onValueChange={(v) => chooseRange(v as RangeId)} />
      </div>

      {byDay.isError && <p className="text-[13px] text-error">{errorMessage(byDay.error)}</p>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Cost" hint={totals && totals.unknown_cost_requests > 0
          ? `${totals.unknown_cost_requests} call${totals.unknown_cost_requests === 1 ? '' : 's'} without a known price`
          : undefined}>
          {/* The note below says when part of it is unknown. */}
          {!totals ? '…' : totals.requests > 0 && totals.unknown_cost_requests === totals.requests ? 'unknown' : formatCost(totals.cost_usd)}
        </Stat>
        <Stat label="Model calls">{totals ? formatCount(totals.requests) : '…'}</Stat>
        <Stat label="Tokens in">{totals ? formatCount(totals.input_tokens) : '…'}</Stat>
        <Stat label="Tokens out">{totals ? formatCount(totals.output_tokens) : '…'}</Stat>
      </div>

      <Card>
        <CardHeader title="Per day"
          actions={<Select className="h-9 w-28" aria-label="What the chart shows" value={metric} options={METRICS} onValueChange={(v) => setMetric(v as Metric)} />} />
        <CardBody><DayChart bars={bars} formatValue={formatMetric(metric)} /></CardBody>
      </Card>

      <Card>
        <CardHeader title="Breakdown"
          actions={<Select className="h-9 w-48" aria-label="Group by" value={grouping} options={GROUPINGS} onValueChange={(v) => setGrouping(v as Exclude<GroupBy, 'day'>)} />} />
        <CardBody>
          {breakdown.isError
            ? <p className="text-[13px] text-error">{errorMessage(breakdown.error)}</p>
            : <Breakdown groups={breakdown.data?.groups ?? []} grouping={grouping} />}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Model calls" description="Every single call in this period, newest first." />
        <CardBody><RecentCalls range={range} /></CardBody>
      </Card>
    </div>
  )
}
