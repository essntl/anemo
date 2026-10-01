/**
 * Date helpers for tasks and the calendar. Days are "YYYY-MM-DD" strings in the
 * browser's time zone (what the user sees on their wall calendar).
 */
import type { Task } from './api'

const pad = (n: number) => String(n).padStart(2, '0')

/** A Date as its local calendar day, "YYYY-MM-DD". */
export const dayOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

export const today = () => dayOf(new Date())

export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00`)
  d.setDate(d.getDate() + days)
  return dayOf(d)
}

/** "Today", "Tomorrow", "Mon 5 Oct" (with the year when it is not this year). */
export function formatDay(day: string, now = today()): string {
  if (day === now) return 'Today'
  if (day === addDays(now, 1)) return 'Tomorrow'
  if (day === addDays(now, -1)) return 'Yesterday'
  const d = new Date(`${day}T12:00:00`)
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(day.slice(0, 4) !== now.slice(0, 4) ? { year: 'numeric' } : {}),
  })
}

export function formatDue(task: Pick<Task, 'due_date' | 'due_time'>, now = today()): string {
  if (!task.due_date) return ''
  return task.due_time ? `${formatDay(task.due_date, now)} ${task.due_time.slice(0, 5)}` : formatDay(task.due_date, now)
}

export type Bucket = 'overdue' | 'today' | 'upcoming' | 'later' | 'none'

export const BUCKET_LABELS: Record<Bucket, string> = {
  overdue: 'Overdue',
  today: 'Today',
  upcoming: 'Next 7 days',
  later: 'Later',
  none: 'No date',
}

/** Which section of the task list an open task belongs to. */
export function bucketOf(task: Pick<Task, 'due_date'>, now = today()): Bucket {
  if (!task.due_date) return 'none'
  if (task.due_date < now) return 'overdue'
  if (task.due_date === now) return 'today'
  return task.due_date <= addDays(now, 7) ? 'upcoming' : 'later'
}

/** Reminder choices, in minutes before the due time / event start. */
export const REMINDER_OPTIONS = [
  { value: '', label: 'No reminder' },
  { value: '0', label: 'At the time' },
  { value: '10', label: '10 minutes before' },
  { value: '30', label: '30 minutes before' },
  { value: '60', label: '1 hour before' },
  { value: '1440', label: '1 day before' },
  { value: '10080', label: '1 week before' },
]
