import { msg } from '@/lib/i18n'

/** How long ago a chat was last active, as offered by the "When" filter of All chats. */
export const AGES = [
  { value: '', label: msg('Any time') },
  { value: 'today', label: msg('Today') },
  { value: 'yesterday', label: msg('Yesterday') },
  { value: 'week', label: msg('Past week') },
  { value: 'month', label: msg('Past month') },
  { value: 'older', label: msg('Older') },
]

/**
 * The stretch of time an age stands for, as ISO instants for the server
 * (`after` included, `before` excluded). Days are the user's own calendar days:
 * "Past week" is today and the six days before it, "Older" is everything before
 * the past month (30 days).
 */
export function ageRange(age: string, now = new Date()): { after?: string; before?: string } {
  const daysAgo = (n: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - n).toISOString()
  switch (age) {
    case 'today': return { after: daysAgo(0) }
    case 'yesterday': return { after: daysAgo(1), before: daysAgo(0) }
    case 'week': return { after: daysAgo(6) }
    case 'month': return { after: daysAgo(29) }
    case 'older': return { before: daysAgo(29) }
    default: return {}
  }
}
