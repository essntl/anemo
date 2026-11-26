import { t } from '@/lib/i18n'
import type { ActivityEntry } from './api'

/** One row of the list: an entry on its own, or the entries of one batch. */
export type Row = { kind: 'entry'; entry: ActivityEntry } | { kind: 'group'; id: string; label: string; entries: ActivityEntry[] }

/**
 * The entries of one batch become one row, wherever they are in the list (another change can
 * fall between them, and a batch can go on in the next page): the row stands where its newest
 * entry is. The list is newest first, and so is each batch.
 */
export function toRows(entries: ActivityEntry[]): Row[] {
  const rows: Row[] = []
  const groups = new Map<string, Extract<Row, { kind: 'group' }>>()
  for (const entry of entries) {
    if (!entry.group_id) {
      rows.push({ kind: 'entry', entry })
      continue
    }
    const group = groups.get(entry.group_id)
    if (group) group.entries.push(entry)
    else {
      const row: Extract<Row, { kind: 'group' }> = { kind: 'group', id: entry.group_id, label: entry.group_label ?? t('A batch of changes'), entries: [entry] }
      groups.set(entry.group_id, row)
      rows.push(row)
    }
  }
  // A group of one is shown as that entry.
  return rows.map((r) => (r.kind === 'group' && r.entries.length === 1 ? { kind: 'entry', entry: r.entries[0] } : r))
}
