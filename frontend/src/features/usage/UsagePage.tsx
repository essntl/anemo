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
import { msg, plural, rich, t } from '@/lib/i18n'
import { type GroupBy, type UsageGroup, type UsageTotals, useUsageRecords, useUsageSummary } from './api'
import { type DayBar, DayChart } from './components/DayChart'
import { daysIn, type RangeId, rangeFor, RANGES } from './ranges'

const GROUPINGS: { value: Exclude<GroupBy, 'day'>; label: string; column: string }[] = [
  { value: 'model', label: msg('By model'), column: msg('model') },
  { value: 'kind', label: msg('By kind of work'), column: msg('kind of work') },
  { value: 'provider', label: msg('By provider'), column: msg('provider') },
  { value: 'profile', label: msg('By agent profile'), column: msg('agent profile') },
  { value: 'automation', label: msg('By automation'), column: msg('automation') },
]
const KIND_LABELS: Record<string, string> = {
  chat: msg('Chat'), agent: msg('Agent'), title: msg('Naming chats'), memory: msg('Memory'), embedding: msg('Search index'),
  summarize: msg('Summaries'), test: msg('Connection tests'),
} // prettier-ignore

type Metric = 'cost' | 'tokens' | 'requests'
const METRICS: { value: Metric; label: string }[] = [
  { value: 'cost', label: msg('Cost') },
  { value: 'tokens', label: msg('Tokens') },
  { value: 'requests', label: msg('Calls') },
]

const valueOf = (t: UsageTotals, metric: Metric) =>
  metric === 'cost' ? t.cost_usd : metric === 'tokens' ? t.input_tokens + t.output_tokens : t.requests
const formatMetric = (metric: Metric) => (value: number) =>
  metric === 'cost' ? formatCost(value) : formatCount(Math.round(value))

/** "$1.20", or "$1.20 + unknown" when some calls have no known cost. */
function Cost({ totals }: { totals: UsageTotals }) {
  if (totals.unknown_cost_requests === totals.requests && totals.requests > 0) return <>{t('unknown')}</>
  return (
    <>
      {formatCost(totals.cost_usd)}
      {totals.unknown_cost_requests > 0 && <span className="text-muted"> + {t('unknown')}</span>}
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
  if (groups.length === 0) return <p className="text-[13px] text-muted">{t('Nothing in this period.')}</p>
  const label = (g: UsageGroup) => (grouping === 'kind' ? (KIND_LABELS[g.label] ? t(KIND_LABELS[g.label]) : g.label) : g.label)
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[13px]">
        <thead className="text-[11px] uppercase tracking-wider text-subtle">
          <tr>
            <th className="py-1.5 pr-3 font-semibold">{t(GROUPINGS.find((g) => g.value === grouping)?.column ?? '')}</th>
            <th className="px-3 py-1.5 text-right font-semibold">{t('Cost')}</th>
            <th className="px-3 py-1.5 text-right font-semibold">{t('Calls')}</th>
            <th className="px-3 py-1.5 text-right font-semibold">{t('Tokens in')}</th>
            <th className="py-1.5 pl-3 text-right font-semibold">{t('Tokens out')}</th>
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
  if (records.isSuccess && rows.length === 0) return <p className="text-[13px] text-muted">{t('No model calls in this period.')}</p>
  return (
    <>
      <ul className="text-[13px]">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center gap-3 border-t border-border py-2 first:border-t-0">
            <span className="w-24 shrink-0 text-[12px] text-muted sm:w-32">{formatWhen(r.ts)}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{r.model_key}</span>
              <span className="block truncate text-[12px] text-muted">
                {KIND_LABELS[r.request_kind] ? t(KIND_LABELS[r.request_kind]) : r.request_kind} · {r.provider_name}
                {r.run_id && <> · <Link to={`/runs/${r.run_id}`} className="text-accent hover:underline">{t('run')}</Link></>}
              </span>
            </span>
            <span className="shrink-0 text-right tabular-nums">
              <span className="block">{r.cost_usd == null ? t('unknown') : formatCost(r.cost_usd)}</span>
              <span className="block text-[12px] text-muted">
                {t('{input} in · {output} out', { input: r.input_tokens == null ? '?' : formatCount(r.input_tokens), output: r.output_tokens == null ? '?' : formatCount(r.output_tokens) })}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {records.hasNextPage && (
        <div className="mt-3 flex justify-center">
          <Button size="sm" variant="secondary" loading={records.isFetchingNextPage} onClick={() => void records.fetchNextPage()}>
            {t('Load more')}
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
      detail: g ? plural(g.requests, '{n} call, {cost}', '{n} calls, {cost}', { cost: formatCost(g.cost_usd) + (g.unknown_cost_requests ? ' + ' + t('unknown') : '') }) : t('nothing'),
    }
  })

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <BarChart3 className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">{t('Usage')}</h2>
          <p className="text-[13px] text-muted">
            {rich('Model calls, tokens and cost. Costs are what the provider reported, or worked out from the prices set in <a>Providers & Models</a>.', { a: (c) => <Link to="/settings/providers" className="text-accent underline">{c}</Link> })}
          </p>
        </div>
        <Select className="w-full sm:w-44" aria-label={t('Period')} value={rangeId} options={RANGES.map((r) => ({ value: r.id, label: t(r.label) }))}
          onValueChange={(v) => chooseRange(v as RangeId)} />
      </div>

      {byDay.isError && <p className="text-[13px] text-error">{errorMessage(byDay.error)}</p>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={t('Cost')} hint={totals && totals.unknown_cost_requests > 0
          ? plural(totals.unknown_cost_requests, '{n} call without a known price', '{n} calls without a known price')
          : undefined}>
          {/* The note below says when part of it is unknown. */}
          {!totals ? '…' : totals.requests > 0 && totals.unknown_cost_requests === totals.requests ? t('unknown') : formatCost(totals.cost_usd)}
        </Stat>
        <Stat label={t('Model calls')}>{totals ? formatCount(totals.requests) : '…'}</Stat>
        <Stat label={t('Tokens in')}>{totals ? formatCount(totals.input_tokens) : '…'}</Stat>
        <Stat label={t('Tokens out')}>{totals ? formatCount(totals.output_tokens) : '…'}</Stat>
      </div>

      <Card>
        <CardHeader title={t('Per day')}
          actions={<Select className="h-9 w-28" aria-label={t('What the chart shows')} value={metric} options={METRICS.map((m) => ({ value: m.value, label: t(m.label) }))} onValueChange={(v) => setMetric(v as Metric)} />} />
        <CardBody><DayChart bars={bars} formatValue={formatMetric(metric)} /></CardBody>
      </Card>

      <Card>
        <CardHeader title={t('Breakdown')}
          actions={<Select className="h-9 w-48" aria-label={t('Group by')} value={grouping} options={GROUPINGS.map((g) => ({ value: g.value, label: t(g.label) }))} onValueChange={(v) => setGrouping(v as Exclude<GroupBy, 'day'>)} />} />
        <CardBody>
          {breakdown.isError
            ? <p className="text-[13px] text-error">{errorMessage(breakdown.error)}</p>
            : <Breakdown groups={breakdown.data?.groups ?? []} grouping={grouping} />}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t('Model calls')} description={t('Every single call in this period, newest first.')} />
        <CardBody><RecentCalls range={range} /></CardBody>
      </Card>
    </div>
  )
}
