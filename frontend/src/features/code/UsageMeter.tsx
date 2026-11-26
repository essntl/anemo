/**
 * The usage indicator (docs/specs/code-sessions.md §14): how much of the Claude
 * subscription's 5-hour and weekly windows a computer's jobs have used, and when each
 * resets, as of the newest `rate_limit_event`. Compact: a thin bar and a percentage per
 * window; the details (every window, "as of") in its title.
 */
import { Gauge } from 'lucide-react'
import { cn } from '@/lib/cn'
import { formatAgo, formatDateTime, formatUpcoming } from '@/lib/format'
import { t } from '@/lib/i18n'
import { useCodeUsage } from './api'
import { type CodeUsage, type UsageView, percent, usageOf, usageWindows, windowLabel } from './usage'

function describe(v: UsageView): string {
  const label = windowLabel(v.name)
  if (v.reset) return t('{window}: reset at {when}', { window: label, when: v.resetsAt ? formatDateTime(v.resetsAt.toISOString()) : '' })
  const used = v.used !== null ? percent(v.used) : t('unknown')
  return v.resetsAt
    ? t('{window}: {used} used, resets {when}', { window: label, used, when: formatDateTime(v.resetsAt.toISOString()) })
    : t('{window}: {used} used', { window: label, used })
}

function Window({ v }: { v: UsageView }) {
  const fill = v.limited ? 'bg-error' : v.warning ? 'bg-warning' : 'bg-accent'
  const shown = v.used === null ? 0 : Math.min(1, v.used)
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-subtle">{windowLabel(v.name)}</span>
      <span role="meter" aria-label={describe(v)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(shown * 100)}
        className="relative h-1.5 w-10 shrink-0 overflow-hidden rounded-full bg-surface-2">
        <span className={cn('absolute inset-y-0 left-0 rounded-full', fill)} style={{ width: `${shown * 100}%` }} />
      </span>
      <span className={cn('shrink-0 tabular-nums', v.limited ? 'font-medium text-error' : v.warning ? 'text-warning' : 'text-text')}>
        {v.reset ? t('has reset') : v.used !== null ? percent(v.used) : '–'}
      </span>
      {/* The reset of a window that is nearly or fully used is what matters. */}
      {v.resetsAt && !v.reset && (v.limited || v.warning) && (
        <span className="min-w-0 truncate text-muted">{t('resets {when}', { when: formatUpcoming(v.resetsAt.toISOString()) })}</span>
      )}
    </span>
  )
}

/** One computer's usage. `name`: say which computer (when several report one). */
export function UsageMeter({ usage, name, className }: { usage: CodeUsage; name?: boolean; className?: string }) {
  const { main, other } = usageWindows(usage)
  if (!main.length) return null
  const asOf = t('as of {when}', { when: formatAgo(usage.observed_at) })
  const title = [
    name ? usage.device_name : null,
    ...[...main, ...other].map(describe),
    t('Claude subscription usage as of {when}', { when: formatDateTime(usage.observed_at) }),
  ].filter(Boolean).join('\n')
  return (
    <div data-testid="code-usage" title={title}
      className={cn('flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]', className)}>
      <Gauge aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-subtle" />
      {name && <span className="min-w-0 max-w-[8rem] truncate font-medium text-muted">{usage.device_name}</span>}
      {main.map((v) => <Window key={v.name} v={v} />)}
      <span className="shrink-0 text-subtle">{asOf}</span>
    </div>
  )
}

/** Every computer's usage, for the top of the job list; nothing while none has reported one. */
export function CodeUsageBar() {
  const usage = useCodeUsage()
  const all = usage.data ?? []
  if (!all.length) return null
  return (
    <div className="flex flex-col gap-1 px-1 pt-2">
      {all.map((u) => <UsageMeter key={u.device_id} usage={u} name={all.length > 1} />)}
    </div>
  )
}

/** The usage of the job's computer, for the thread's header. */
export function JobUsage({ deviceId }: { deviceId: string }) {
  const usage = usageOf(useCodeUsage().data, deviceId)
  return usage ? <UsageMeter usage={usage} className="mt-2" /> : null
}
