import { t } from '@/lib/i18n'
import type { ActivityEntry } from './api'

/** One row of the list: an entry on its own, or the entries of one batch. */
export type Row = { kind: 'entry'; entry: ActivityEntry } | { kind: 'group'; id: string; label: string; entries: ActivityEntry[] }

/** Entries next to each other that share a group become one row (the list is newest first). */
export function toRows(entries: ActivityEntry[]): Row[] {
  const rows: Row[] = []
  for (const entry of entries) {
    const last = rows[rows.length - 1]
    if (entry.group_id && last?.kind === 'group' && last.id === entry.group_id) last.entries.push(entry)
    else if (entry.group_id) rows.push({ kind: 'group', id: entry.group_id, label: entry.group_label ?? t('A batch of changes'), entries: [entry] })
    else rows.push({ kind: 'entry', entry })
  }
  // A group of one is shown as that entry.
  return rows.map((r) => (r.kind === 'group' && r.entries.length === 1 ? { kind: 'entry', entry: r.entries[0] } : r))
}
