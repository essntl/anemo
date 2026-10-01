/**
 * The schedule editor's simple choices ("every weekday at 08:00") and the
 * schedule the server stores (a cron expression, an interval, or one moment).
 * Schedules that fit no simple choice are edited as a cron expression.
 */
import type { Schemas } from '@/api/client'

export type Schedule = Schemas['Schedule']

export type Frequency = 'minutes' | 'hours' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'once' | 'cron'

export interface ScheduleForm {
  frequency: Frequency
  /** For "minutes" and "hours": how many. */
  every: number
  /** HH:mm, for the daily, weekly, monthly and one-time choices. */
  time: string
  /** 0 = Sunday … 6 = Saturday (as in cron). */
  weekday: number
  monthDay: number
  /** YYYY-MM-DD, for "once". */
  date: string
  cron: string
}

export const FREQUENCY_OPTIONS: { value: Frequency; label: string }[] = [
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Monday to Friday' },
  { value: 'weekly', label: 'Every week' },
  { value: 'monthly', label: 'Every month' },
  { value: 'hours', label: 'Every few hours' },
  { value: 'minutes', label: 'Every few minutes' },
  { value: 'once', label: 'Once' },
  { value: 'cron', label: 'Custom (cron)' },
]

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const pad = (n: number) => String(n).padStart(2, '0')
const dayOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const timeOf = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

export function defaultForm(now = new Date()): ScheduleForm {
  return { frequency: 'daily', every: 2, time: '08:00', weekday: 1, monthDay: 1, date: dayOf(now), cron: '0 8 * * *' }
}

/** "08:05" → "5 8" (cron wants minute first, without leading zeros). */
function cronTime(time: string): string {
  const [h, m] = time.split(':').map(Number)
  return `${m || 0} ${h || 0}`
}

export function toSchedule(form: ScheduleForm, tz: string): Schedule {
  const base = { cron: null, every_minutes: null, at: null, tz }
  switch (form.frequency) {
    case 'minutes':
      return { ...base, kind: 'interval', every_minutes: Math.max(5, Math.round(form.every)) }
    case 'hours':
      return { ...base, kind: 'interval', every_minutes: Math.max(1, Math.round(form.every)) * 60 }
    case 'daily':
      return { ...base, kind: 'cron', cron: `${cronTime(form.time)} * * *` }
    case 'weekdays':
      return { ...base, kind: 'cron', cron: `${cronTime(form.time)} * * 1-5` }
    case 'weekly':
      return { ...base, kind: 'cron', cron: `${cronTime(form.time)} * * ${form.weekday}` }
    case 'monthly':
      return { ...base, kind: 'cron', cron: `${cronTime(form.time)} ${form.monthDay} * *` }
    case 'once': {
      // The date and time are meant in this browser's time zone.
      const at = new Date(`${form.date}T${form.time}`)
      return { ...base, kind: 'once', at: Number.isNaN(at.getTime()) ? null : at.toISOString() }
    }
    default:
      return { ...base, kind: 'cron', cron: form.cron.trim() }
  }
}

export function fromSchedule(schedule: Schedule, now = new Date()): ScheduleForm {
  const form = defaultForm(now)
  if (schedule.kind === 'interval') {
    const minutes = schedule.every_minutes ?? 60
    return minutes % 60 === 0
      ? { ...form, frequency: 'hours', every: minutes / 60 }
      : { ...form, frequency: 'minutes', every: minutes }
  }
  if (schedule.kind === 'once') {
    const at = schedule.at ? new Date(schedule.at) : now
    return { ...form, frequency: 'once', date: dayOf(at), time: timeOf(at) }
  }
  const cron = (schedule.cron ?? '').trim()
  const match = /^(\d{1,2}) (\d{1,2}) (\*|\d{1,2}) \* (\*|1-5|[0-7])$/.exec(cron)
  if (!match) return { ...form, frequency: 'cron', cron }
  const [, minute, hour, day, weekday] = match
  const time = `${pad(Number(hour))}:${pad(Number(minute))}`
  const known = { ...form, time, cron }
  if (day !== '*' && weekday === '*') return { ...known, frequency: 'monthly', monthDay: Number(day) }
  if (day !== '*') return { ...form, frequency: 'cron', cron } // a day of the month and a weekday
  if (weekday === '*') return { ...known, frequency: 'daily' }
  if (weekday === '1-5') return { ...known, frequency: 'weekdays' }
  return { ...known, frequency: 'weekly', weekday: Number(weekday) % 7 }
}
