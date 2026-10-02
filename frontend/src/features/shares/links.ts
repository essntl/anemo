import { formatUpcoming } from '@/lib/format'

/** How long a new link works. '' means until it is revoked. */
export const EXPIRY_OPTIONS = [
  { value: '1', label: '1 day' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '', label: 'Until I revoke it' },
]

/** What a shared project can show. */
export const PROJECT_SECTIONS = [
  { value: 'tasks', label: 'Tasks', hint: 'titles, status and due dates' },
  { value: 'events', label: 'Upcoming events', hint: 'the next 90 days' },
  { value: 'documents', label: 'Documents', hint: 'to read in full' },
] as const

export type ProjectSection = (typeof PROJECT_SECTIONS)[number]['value']

/** The address to hand out. The token is the secret: whoever has it can read the copy. */
export function shareUrl(token: string, origin = window.location.origin): string {
  return `${origin}/s/${token}`
}

/** "No expiry", "Expired", or "Expires Tomorrow 08:00". */
export function expiryLabel(link: { expires_at?: string | null; expired: boolean }, now = new Date()): string {
  if (!link.expires_at) return 'No expiry'
  if (link.expired || new Date(link.expires_at).getTime() <= now.getTime()) return 'Expired'
  return `Expires ${formatUpcoming(link.expires_at, now)}`
}
