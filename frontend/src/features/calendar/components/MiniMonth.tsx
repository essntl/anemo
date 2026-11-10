import { useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { monthGrid } from '../monthGrid'
import { cn } from '@/lib/cn'

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

/**
 * A small month beside the calendar: today, the days the calendar is showing, and a
 * click on a day takes the calendar there. Its arrows page this month only.
 */
export function MiniMonth({ shown, today, onPick }: {
  /** The days the calendar shows: the first, and the day after the last. */
  shown: { start: string; end: string } | null
  today: string
  onPick: (day: string) => void
}) {
  const anchor = shown?.start ?? today
  // The month on show; it follows the calendar until its own arrows are used.
  const [paged, setPaged] = useState<{ from: string; year: number; month: number } | null>(null)
  const base = new Date(`${anchor}T12:00:00`)
  const { year, month } = paged?.from === anchor ? paged : { year: base.getFullYear(), month: base.getMonth() }
  const page = (by: number) => {
    const d = new Date(year, month + by, 1)
    setPaged({ from: anchor, year: d.getFullYear(), month: d.getMonth() })
  }
  const title = new Date(year, month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  // A week or a few days on show are marked; a whole month on show would mark every day.
  const partOfMonth = shown !== null && new Date(`${shown.end}T12:00:00`).getTime() - new Date(`${shown.start}T12:00:00`).getTime() <= 14 * 86_400_000
  const arrow = 'flex h-7 w-7 items-center justify-center rounded-control text-muted hover:bg-surface-hover hover:text-text'
  return (
    <div className="rounded-card border border-border bg-card p-3 shadow-soft">
      <div className="mb-1 flex items-center">
        <span className="flex-1 pl-1 text-[13px] font-semibold">{title}</span>
        <button type="button" aria-label="Previous month" onClick={() => page(-1)} className={arrow}><ChevronLeft className="h-4 w-4" /></button>
        <button type="button" aria-label="Next month" onClick={() => page(1)} className={arrow}><ChevronRight className="h-4 w-4" /></button>
      </div>
      <div className="grid grid-cols-7 text-center text-[12px]">
        {WEEKDAYS.map((d, i) => <span key={i} aria-hidden className="py-1 font-medium text-subtle">{d}</span>)}
        {monthGrid(year, month).map((day) => {
          const inMonth = Number(day.slice(5, 7)) === month + 1
          const inView = partOfMonth && day >= shown.start && day < shown.end
          return (
            <button key={day} type="button" onClick={() => onPick(day)} aria-label={new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
              aria-current={day === today ? 'date' : undefined}
              className={cn('mx-auto my-px flex h-7 w-7 items-center justify-center rounded-full tabular-nums hover:bg-surface-hover',
                !inMonth && 'text-subtle/60', inView && day !== today && 'bg-surface-2',
                day === today && 'bg-accent font-semibold text-accent-contrast hover:bg-accent-hover')}>
              {Number(day.slice(8))}
            </button>
          )
        })}
      </div>
    </div>
  )
}
