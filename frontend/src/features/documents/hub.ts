/** The rows of a hub page, by type. */
import type { LinkType } from '@/features/links/api'
import { msg } from '@/lib/i18n'
import type { HubSection } from './api'

const GROUPS: { type: LinkType; label: string }[] = [
  { type: 'document', label: msg('Documents') },
  { type: 'task', label: msg('Tasks') },
  { type: 'event', label: msg('Events') },
]
/** The section's rows by type, in the order documents, tasks, events (empty ones left out). */
export function hubGroups(rows: HubSection['rows']): { type: LinkType; label: string; rows: HubSection['rows'] }[] {
  return GROUPS.map((g) => ({ ...g, rows: rows.filter((r) => r.type === g.type) })).filter((g) => g.rows.length > 0)
}
