import { useState } from 'react'
import { formatMinutes } from '@/features/focus/api'
import type { DayValue } from './api'

const LEVELS = [
  'var(--ring-track)',
  'color-mix(in oklab, var(--accent) 28%, var(--card))',
  'color-mix(in oklab, var(--accent) 50%, var(--card))',
  'color-mix(in oklab, var(--accent) 75%, var(--card))',
  'var(--accent)',
]
const level = (v: number) => (v === 0 ? 0 : v < 25 ? 1 : v < 60 ? 2 : v < 120 ? 3 : 4)
const CELL = 13
const GAP = 3

/** Six months of focus, one column per week (Monday on top), in five steps of the accent. */
export function Heatmap({ days, today }: { days: DayValue[]; today: string }) {
  const [hover, setHover] = useState<DayValue | null>(null)
  const weeks = Math.ceil(days.length / 7)
  const label = (d: DayValue) => new Date(`${d.day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  const active = days.filter((d) => d.value > 0 && d.day <= today).length
  return (
    <div>
      <div className="overflow-x-auto pb-1">
        <svg width={weeks * (CELL + GAP)} height={7 * (CELL + GAP)} role="img" onMouseLeave={() => setHover(null)}
          aria-label={`Focus per day over the last ${weeks} weeks: ${active} days with focus.`}>
          {days.map((d, i) =>
            d.day > today ? null : (
              <rect key={d.day} x={Math.floor(i / 7) * (CELL + GAP)} y={(i % 7) * (CELL + GAP)} width={CELL} height={CELL} rx={3}
                fill={LEVELS[level(d.value)]} onMouseEnter={() => setHover(d)}>
                <title>{`${label(d)}: ${d.value ? formatMinutes(d.value) : 'no focus'}`}</title>
              </rect>
            ),
          )}
        </svg>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted">
        <span className="min-h-4 tabular-nums">{hover ? `${label(hover)} · ${hover.value ? formatMinutes(hover.value) : 'no focus'}` : 'Point at a day for details'}</span>
        <span className="flex items-center gap-1" aria-hidden>
          Less {LEVELS.map((f) => <span key={f} className="h-3 w-3 rounded-[3px]" style={{ background: f }} />)} More
        </span>
      </div>
    </div>
  )
}
