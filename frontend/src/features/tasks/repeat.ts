/**
 * Repeating tasks: the editor's simple choices and how a rule reads. The server stores
 * an RFC 5545 rule; finishing the task adds the next one (see backend tasks/service.py).
 */

export const REPEAT_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Doesn’t repeat' },
  { value: 'FREQ=DAILY', label: 'Every day' },
  { value: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', label: 'Every weekday' },
  { value: 'FREQ=WEEKLY', label: 'Every week' },
  { value: 'FREQ=WEEKLY;INTERVAL=2', label: 'Every 2 weeks' },
  { value: 'FREQ=MONTHLY', label: 'Every month' },
  { value: 'FREQ=YEARLY', label: 'Every year' },
]

const DAYS: Record<string, string> = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' }
const UNIT: Record<string, [string, string]> = {
  DAILY: ['day', 'days'],
  WEEKLY: ['week', 'weeks'],
  MONTHLY: ['month', 'months'],
  YEARLY: ['year', 'years'],
}

/** "Every week", "Every 2 weeks on Mon, Thu", … (rules an agent wrote included). */
export function describeRepeat(rule: string): string {
  const known = REPEAT_OPTIONS.find((o) => o.value === rule)
  if (known) return known.label
  const parts = Object.fromEntries(rule.split(';').map((p) => p.split('=') as [string, string]))
  const unit = UNIT[parts.FREQ ?? '']
  if (!unit) return 'Repeats'
  const n = Number(parts.INTERVAL ?? 1)
  let text = n > 1 ? `Every ${n} ${unit[1]}` : `Every ${unit[0]}`
  if (parts.BYDAY) text += ` on ${parts.BYDAY.split(',').map((d) => DAYS[d.slice(-2)] ?? d).join(', ')}`
  if (parts.BYMONTHDAY) text += ` on day ${parts.BYMONTHDAY}`
  if (parts.UNTIL) text += ` until ${parts.UNTIL.slice(0, 4)}-${parts.UNTIL.slice(4, 6)}-${parts.UNTIL.slice(6, 8)}`
  return text
}

/** The choices, plus the current rule when it is not one of them. */
export function repeatOptions(current: string) {
  if (REPEAT_OPTIONS.some((o) => o.value === current)) return REPEAT_OPTIONS
  return [...REPEAT_OPTIONS, { value: current, label: describeRepeat(current) }]
}
