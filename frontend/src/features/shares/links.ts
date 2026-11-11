import { formatUpcoming } from '@/lib/format'
import { msg, t } from '@/lib/i18n'

/** How long a new link works. '' means until it is revoked. */
export const EXPIRY_OPTIONS = [
  { value: '1', label: msg('1 day') },
  { value: '7', label: msg('7 days') },
  { value: '30', label: msg('30 days') },
  { value: '', label: msg('Until I revoke it') },
]

/** What a shared project can show. */
export const PROJECT_SECTIONS = [
  { value: 'tasks', label: msg('Tasks'), hint: msg('with their notes, status and due dates') },
  { value: 'events', label: msg('Upcoming events'), hint: msg('the next 90 days') },
  { value: 'documents', label: msg('Documents'), hint: msg('to read in full') },
] as const

export type ProjectSection = (typeof PROJECT_SECTIONS)[number]['value']

/** The address to hand out. The token is the secret: whoever has it can read the copy. */
export function shareUrl(token: string, origin = window.location.origin): string {
  return `${origin}/s/${token}`
}

/** "No expiry", "Expired", or "Expires Tomorrow 08:00". */
export function expiryLabel(link: { expires_at?: string | null; expired: boolean }, now = new Date()): string {
  if (!link.expires_at) return t('No expiry')
  if (link.expired || new Date(link.expires_at).getTime() <= now.getTime()) return t('Expired')
  return t('Expires {when}', { when: formatUpcoming(link.expires_at, now) })
}
