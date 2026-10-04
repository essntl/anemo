/** Helpers for the calendar's entries (events and tasks, as FullCalendar inputs). */
import type { EventInput } from '@fullcalendar/core'
import { addDays, dayOf } from '@/features/tasks/dates'

/** The days an entry covers ("YYYY-MM-DD"); an all-day entry's end is the day after. */
export function daysOf(entry: EventInput): string[] {
  const first = dayOf(new Date(String(entry.start).length === 10 ? `${entry.start}T12:00:00` : String(entry.start)))
  const endRaw = entry.end ? String(entry.end) : null
  let last = first
  if (endRaw) {
    last = entry.allDay ? addDays(endRaw.slice(0, 10), -1) : dayOf(new Date(new Date(endRaw).getTime() - 1))
  }
  const days = [first]
  for (let d = first; d < last && days.length < 62; ) {
    d = addDays(d, 1)
    days.push(d)
  }
  return days
}

/** The colour an entry shows in (an event's own colour, else the accent); tasks have none. */
export function colorOf(entry: EventInput): string | null {
  if (entry.extendedProps?.task) return null
  return (entry.backgroundColor as string | undefined) ?? 'var(--accent)'
}
