import { startOfToday } from '@/features/focus/api'

/** Monday of this week (weeks start on Monday). */
export function startOfWeek(now = new Date()): Date {
  const d = startOfToday(now)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d
}

/** [start, end) of one local day, as ISO instants for the API. */
export function dayRange(day: Date, days = 1): { start: string; end: string } {
  const start = startOfToday(day)
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + days)
  return { start: start.toISOString(), end: end.toISOString() }
}

/** "09:30" for a timed occurrence. */
export function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
