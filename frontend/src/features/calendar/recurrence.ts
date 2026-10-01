/**
 * Repeat settings in the event dialog <-> the RRULE text stored with the event
 * (e.g. "FREQ=WEEKLY;INTERVAL=2;UNTIL=20261231T235959"). Rules that do not match
 * a preset (made by an agent, say) are kept as they are and shown as "Custom".
 */
export type Repeat = 'none' | 'daily' | 'weekdays' | 'weekly' | 'biweekly' | 'monthly' | 'yearly' | 'custom'

const PRESETS: Record<Exclude<Repeat, 'none' | 'custom'>, string> = {
  daily: 'FREQ=DAILY',
  weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
  weekly: 'FREQ=WEEKLY',
  biweekly: 'FREQ=WEEKLY;INTERVAL=2',
  monthly: 'FREQ=MONTHLY',
  yearly: 'FREQ=YEARLY',
}

export const REPEAT_OPTIONS: { value: Repeat; label: string }[] = [
  { value: 'none', label: 'Does not repeat' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Every weekday (Mon–Fri)' },
  { value: 'weekly', label: 'Every week' },
  { value: 'biweekly', label: 'Every 2 weeks' },
  { value: 'monthly', label: 'Every month' },
  { value: 'yearly', label: 'Every year' },
]

/** `until` is the last day ("YYYY-MM-DD") or "" for no end. */
export function toRRule(repeat: Repeat, until: string, custom: string): string | null {
  if (repeat === 'none') return null
  if (repeat === 'custom') return custom || null
  const end = until ? `;UNTIL=${until.replaceAll('-', '')}T235959` : ''
  return PRESETS[repeat] + end
}

export function fromRRule(rrule: string | null | undefined): { repeat: Repeat; until: string } {
  if (!rrule) return { repeat: 'none', until: '' }
  const parts = rrule.toUpperCase().split(';').filter(Boolean)
  const untilPart = parts.find((p) => p.startsWith('UNTIL='))
  const rest = parts.filter((p) => !p.startsWith('UNTIL=')).join(';')
  const match = (Object.entries(PRESETS) as [Repeat, string][]).find(([, rule]) => rule === rest)
  if (!match) return { repeat: 'custom', until: '' }
  const digits = untilPart?.slice(6, 14) ?? ''
  const until = digits.length === 8 ? `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}` : ''
  return { repeat: match[0], until }
}
