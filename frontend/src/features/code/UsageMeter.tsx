/**
 * The usage indicator (docs/specs/code-sessions.md §14): how much of the Claude
 * subscription's 5-hour and weekly windows a computer's jobs have used, and when each
 * resets, as of the newest `rate_limit_event`. Compact: a thin bar and a percentage per
 * window; the details (every window, its reset, when it was measured) in a popup that
 * opens on hover, on focus and on a tap, and closes with Escape.
 */
import { type PointerEvent, useId, useState } from 'react'
import { Gauge } from 'lucide-react'
import { useShortcut } from '@/hooks/useShortcut'
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

/** The popup's line for a window: what is used and when it resets. */
function Detail({ v }: { v: UsageView }) {
  const when = v.resetsAt ? formatDateTime(v.resetsAt.toISOString()) : null
  return (
    <>
      <dt className="text-muted">{windowLabel(v.name)}</dt>
      <dd className="text-right tabular-nums">{v.reset ? t('has reset') : v.used !== null ? percent(v.used) : '–'}</dd>
      <dd className="col-span-2 -mt-0.5 text-[11.5px] text-subtle">
        {when ? (v.reset ? t('reset at {when}', { when }) : t('resets {when}', { when })) : t('reset time not known')}
      </dd>
    </>
  )
}

/** One computer's usage. `name`: say which computer (when several report one). */
export function UsageMeter({ usage, name, className }: { usage: CodeUsage; name?: boolean; className?: string }) {
  const [pinned, setPinned] = useState(false)
  const [hovered, setHovered] = useState(false)
  const open = pinned || hovered
  const popupId = useId()
  useShortcut('app.close', () => {
    setPinned(false)
    setHovered(false)
  }, { enabled: open })
  const { main, other } = usageWindows(usage)
  if (!main.length) return null
  // Hover is for a mouse only: a tap also sends pointer events, and would leave it open.
  const hover = (on: boolean) => (e: PointerEvent<HTMLElement>) => {
    if (e.pointerType === 'mouse') setHovered(on)
  }
  return (
    <div data-testid="code-usage" className={cn('relative min-w-0', className)}
      onPointerEnter={hover(true)} onPointerLeave={hover(false)}>
      <button type="button" aria-expanded={open} aria-controls={open ? popupId : undefined}
        aria-describedby={open ? popupId : undefined}
        aria-label={[name ? usage.device_name : null, ...main.map(describe)].filter(Boolean).join('; ')}
        onClick={() => setPinned(!pinned)} onFocus={() => setPinned(true)} onBlur={() => setPinned(false)}
        className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-1 py-0.5 text-left text-[11.5px] hover:bg-surface-hover">
        <Gauge aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-subtle" />
        {name && <span className="min-w-0 max-w-[8rem] truncate font-medium text-muted">{usage.device_name}</span>}
        {main.map((v) => <Window key={v.name} v={v} />)}
      </button>
      {open && (
        <div id={popupId} role="tooltip"
          className="absolute left-0 top-full z-20 mt-1 w-64 rounded-lg border border-border bg-surface p-2.5 text-[12px] text-text shadow-float">
          <p className="mb-1.5 font-medium">
            {name ? usage.device_name : t('Claude subscription usage')}
          </p>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
            {[...main, ...other].map((v) => <Detail key={v.name} v={v} />)}
          </dl>
          <p className="mt-2 border-t border-border pt-1.5 text-[11.5px] text-muted">
            {t('Measured {ago} ({when}), when a job last reported it.', {
              ago: formatAgo(usage.observed_at),
              when: formatDateTime(usage.observed_at),
            })}
          </p>
        </div>
      )}
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
