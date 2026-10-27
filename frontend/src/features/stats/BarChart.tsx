import { useState } from 'react'
import { cn } from '@/lib/cn'
import { formatMinutes } from '@/features/focus/api'

export interface Bar {
  key: string
  /** Full name for the tooltip and screen readers ("Mon, Oct 5"). */
  label: string
  /** Under the bar ("M", "5"). */
  short: string
  value: number
  highlight?: boolean
}

/**
 * One series of bars (minutes per day, or any count with `format`). Hovering or
 * focusing a bar shows its value; a dashed line marks a goal when there is one.
 */
export function BarChart({ data, height = 180, goal, format = formatMinutes, className }: {
  data: Bar[]
  height?: number
  goal?: number
  format?: (v: number) => string
  className?: string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const minutes = format === formatMinutes
  const raw = Math.max(minutes ? 30 : 4, goal ?? 0, ...data.map((d) => d.value))
  const step = minutes ? 30 : raw > 20 ? 10 : raw > 8 ? 2 : 1
  const top = Math.ceil(raw / step) * step
  const ticks = height < 110 ? [0, top] : [0, top / 2, top]
  const tick = (t: number) => (minutes ? (t >= 60 ? `${Math.round((t / 60) * 10) / 10}h` : `${t}m`) : String(Math.round(t)))
  const total = data.reduce((s, d) => s + d.value, 0)

  return (
    <div className={cn('relative', className)} role="img" aria-label={`${data.map((d) => `${d.label}: ${format(d.value)}`).join(', ')}. Total ${format(total)}.`}>
      <div className="flex gap-2" aria-hidden>
        <div className="relative w-8 shrink-0 text-right text-[10.5px] text-muted tabular-nums" style={{ height }}>
          {ticks.map((t) => (
            <span key={t} className="absolute right-0 -translate-y-1/2" style={{ top: `${(1 - t / top) * 100}%` }}>{tick(t)}</span>
          ))}
        </div>
        <div className="relative flex-1" style={{ height }}>
          {ticks.map((t) => <div key={t} className="absolute inset-x-0 border-t border-border" style={{ top: `${(1 - t / top) * 100}%` }} />)}
          {goal ? <div className="absolute inset-x-0 border-t border-dashed border-accent opacity-60" style={{ top: `${(1 - goal / top) * 100}%` }} /> : null}
          <div className="absolute inset-0 flex items-end gap-[3px]" onMouseLeave={() => setHover(null)}>
            {data.map((d, i) => (
              <div key={d.key} className="relative flex h-full flex-1 items-end justify-center" onMouseEnter={() => setHover(i)}>
                <div className={cn('w-full max-w-7 rounded-t-[4px] transition-[height,opacity] duration-500 motion-reduce:transition-none', hover !== null && hover !== i && 'opacity-45')}
                  style={{
                    height: `${(d.value / top) * 100}%`,
                    minHeight: d.value > 0 ? 3 : 0,
                    background: d.highlight ? 'var(--accent)' : 'color-mix(in oklab, var(--accent) 55%, var(--card))',
                  }} />
              </div>
            ))}
          </div>
          {hover !== null && (
            <div className="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-control border border-border bg-card px-2.5 py-1 text-center shadow-float"
              style={{ left: `${((hover + 0.5) / data.length) * 100}%` }}>
              <div className="text-[11px] text-muted">{data[hover].label}</div>
              <div className="text-[13px] font-semibold tabular-nums">{format(data[hover].value)}</div>
            </div>
          )}
        </div>
      </div>
      <div className="ml-10 mt-1.5 flex gap-[3px]" aria-hidden>
        {data.map((d, i) => (
          <span key={d.key} className={cn('flex-1 text-center text-[10.5px] text-muted', d.highlight && 'font-semibold text-text')}>
            {data.length > 16 && i % 2 === 1 ? '' : d.short}
          </span>
        ))}
      </div>
    </div>
  )
}
