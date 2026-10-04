import type { EventInput } from '@fullcalendar/core'
import { CalendarDays } from 'lucide-react'
import { formatDay } from '@/features/tasks/dates'
import { cn } from '@/lib/cn'
import { colorOf, daysOf } from '../entries'

const TIME = { hour: '2-digit', minute: '2-digit', hour12: false } as const

/**
 * On a phone, under the month grid: what is on the chosen day. Tapping an entry
 * opens it, as tapping it in the calendar does.
 */
export function DayList({ day, entries, onOpen }: { day: string; entries: EventInput[]; onOpen: (entry: EventInput) => void }) {
  const onDay = entries
    .filter((e) => daysOf(e).includes(day))
    .sort((a, b) => Number(!a.allDay) - Number(!b.allDay) || String(a.start).localeCompare(String(b.start)))
  return (
    <section aria-label={`On ${formatDay(day)}`} className="mt-3">
      <h2 className="px-1 pb-1.5 text-[12px] font-semibold uppercase tracking-wider text-subtle">{formatDay(day)}</h2>
      {onDay.length === 0 ? (
        <p className="flex items-center gap-2 rounded-card border border-dashed border-border px-4 py-5 text-[13.5px] text-muted">
          <CalendarDays className="h-4 w-4" /> Nothing planned. Tap + to add something.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {onDay.map((e) => {
            const color = colorOf(e)
            const task = e.extendedProps?.task as { status: string } | undefined
            const done = task && (task.status === 'done' || task.status === 'cancelled')
            return (
              <li key={String(e.id)}>
                <button type="button" onClick={() => onOpen(e)}
                  className="flex min-h-12 w-full items-center gap-3 rounded-card border border-border bg-card px-3 py-2 text-left hover:bg-surface-hover">
                  <span aria-hidden className={cn('h-8 w-1 shrink-0 rounded-full', !color && 'border border-dashed border-border-strong')}
                    style={color ? { backgroundColor: color } : undefined} />
                  <span className="w-12 shrink-0 text-[12.5px] tabular-nums text-muted">
                    {e.allDay ? 'All day' : new Date(String(e.start)).toLocaleTimeString([], TIME)}
                  </span>
                  <span className={cn('min-w-0 flex-1 line-clamp-2 text-[14.5px]', done && 'text-muted line-through')}>
                    {task && <span aria-hidden>{done ? '☑ ' : '☐ '}</span>}
                    {e.title}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
