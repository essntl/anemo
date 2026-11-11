/**
 * Repeating tasks: the editor's simple choices and how a rule reads. The server stores
 * an RFC 5545 rule; finishing the task adds the next one (see backend tasks/service.py).
 */
import { msg, plural, t } from '@/lib/i18n'

export const REPEAT_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: msg('Doesn’t repeat') },
  { value: 'FREQ=DAILY', label: msg('Every day') },
  { value: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', label: msg('Every weekday') },
  { value: 'FREQ=WEEKLY', label: msg('Every week') },
  { value: 'FREQ=WEEKLY;INTERVAL=2', label: msg('Every 2 weeks') },
  { value: 'FREQ=MONTHLY', label: msg('Every month') },
  { value: 'FREQ=YEARLY', label: msg('Every year') },
]

const DAYS: Record<string, string> = { MO: msg('Mon'), TU: msg('Tue'), WE: msg('Wed'), TH: msg('Thu'), FR: msg('Fri'), SA: msg('Sat'), SU: msg('Sun') }
/** "Every week" or "Every 3 weeks", by the rule's FREQ. */
const EVERY: Record<string, (n: number) => string> = {
  DAILY: (n) => (n > 1 ? plural(n, 'Every {n} day', 'Every {n} days') : t('Every day')),
  WEEKLY: (n) => (n > 1 ? plural(n, 'Every {n} week', 'Every {n} weeks') : t('Every week')),
  MONTHLY: (n) => (n > 1 ? plural(n, 'Every {n} month', 'Every {n} months') : t('Every month')),
  YEARLY: (n) => (n > 1 ? plural(n, 'Every {n} year', 'Every {n} years') : t('Every year')),
}

/** "Every week", "Every 2 weeks on Mon, Thu", … (rules an agent wrote included). */
export function describeRepeat(rule: string): string {
  const known = REPEAT_OPTIONS.find((o) => o.value === rule)
  if (known) return t(known.label)
  const parts = Object.fromEntries(rule.split(';').map((p) => p.split('=') as [string, string]))
  const every = EVERY[parts.FREQ ?? '']
  if (!every) return t('Repeats')
  const n = Number(parts.INTERVAL ?? 1)
  let text = every(n)
  if (parts.BYDAY) text = t('{repeat} on {days}', { repeat: text, days: parts.BYDAY.split(',').map((d) => (DAYS[d.slice(-2)] ? t(DAYS[d.slice(-2)]) : d)).join(', ') })
  if (parts.BYMONTHDAY) text = t('{repeat} on day {day}', { repeat: text, day: parts.BYMONTHDAY })
  if (parts.UNTIL) text = t('{repeat} until {date}', { repeat: text, date: `${parts.UNTIL.slice(0, 4)}-${parts.UNTIL.slice(4, 6)}-${parts.UNTIL.slice(6, 8)}` })
  return text
}

/** The choices in the current language, plus the current rule when it is not one of them. */
export function repeatOptions(current: string) {
  const options = REPEAT_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))
  if (REPEAT_OPTIONS.some((o) => o.value === current)) return options
  return [...options, { value: current, label: describeRepeat(current) }]
}
