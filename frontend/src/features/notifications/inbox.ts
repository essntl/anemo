import { msg } from '@/lib/i18n'
import type { Notification } from './api'

/**
 * What a notification is about, for the Inbox's filter chips. The stored `kind` says who
 * may receive it (Settings > Notifications); this splits it the way the list reads:
 * a finished Claude Code job is an agent notification that links to /code/….
 */
export type Category = 'job' | 'automation' | 'reminder' | 'agent' | 'system'

export const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'job', label: msg('Jobs') },
  { id: 'automation', label: msg('Automations') },
  { id: 'reminder', label: msg('Reminders') },
  { id: 'agent', label: msg('Agents') },
  { id: 'system', label: msg('System') },
]

export function categoryOf(note: Pick<Notification, 'kind' | 'link'>): Category {
  if (note.link?.startsWith('/code/')) return 'job'
  switch (note.kind) {
    case 'automation':
      return 'automation'
    case 'reminder':
      return 'reminder'
    case 'agent':
    case 'approval':
      return 'agent'
    default:
      return 'system' // the focus timer, and kinds added later
  }
}

export type Day = 'today' | 'yesterday' | 'earlier'

export const DAY_LABELS: Record<Day, string> = { today: msg('Today'), yesterday: msg('Yesterday'), earlier: msg('Earlier') }

/** Today, Yesterday or Earlier, by the local calendar day (not 24-hour spans). */
export function dayOf(iso: string, now = new Date()): Day {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const at = new Date(iso).getTime()
  if (at >= midnight) return 'today'
  if (at >= new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime()) return 'yesterday'
  return 'earlier'
}

/** The notifications in day groups, newest first, leaving out empty days. */
export function byDay<T extends Pick<Notification, 'created_at'>>(notes: T[], now = new Date()): { day: Day; notes: T[] }[] {
  const groups: Record<Day, T[]> = { today: [], yesterday: [], earlier: [] }
  for (const n of notes) groups[dayOf(n.created_at, now)].push(n)
  return (Object.keys(groups) as Day[]).filter((d) => groups[d].length > 0).map((day) => ({ day, notes: groups[day] }))
}

/** How many of the given notifications are in each category (for the chips' counts). */
export function countByCategory(notes: Pick<Notification, 'kind' | 'link'>[]): Record<Category, number> {
  const out: Record<Category, number> = { job: 0, automation: 0, reminder: 0, agent: 0, system: 0 }
  for (const n of notes) out[categoryOf(n)] += 1
  return out
}
