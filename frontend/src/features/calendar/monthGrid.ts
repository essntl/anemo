import { addDays, dayOf } from '@/features/tasks/dates'

/** The days of the weeks a month touches, Monday first ("YYYY-MM-DD"). */
export function monthGrid(year: number, month: number): string[] {
  const first = new Date(year, month, 1)
  const start = addDays(dayOf(first), -((first.getDay() + 6) % 7))
  const last = new Date(year, month + 1, 0)
  const days = (first.getDay() + 6) % 7 + last.getDate()
  return Array.from({ length: Math.ceil(days / 7) * 7 }, (_, i) => addDays(start, i))
}
