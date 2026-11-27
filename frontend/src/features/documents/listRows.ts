import { msg, t } from '@/lib/i18n'
import type { DocumentSummary } from './api'
import type { GroupBy, SortBy } from './docListStore'

/**
 * A group's heading (`group` is its id, e.g. `folder:thesis`, `type:plan`, `pinned`), or a
 * document. `prefix`: how many characters at the start of the title other documents in
 * its group share (shown fainter); 0 for none.
 */
export type ListRow =
  | { kind: 'group'; key: string; group: string; label: string; count: number; folded: boolean }
  | { kind: 'doc'; key: string; doc: DocumentSummary; prefix: number }

/** The values of a select property in their order, with their labels (Settings > Properties). */
export type Vocabulary = { slug: string; label: string }[]

export interface RowOptions {
  groupBy?: GroupBy
  sortBy?: SortBy
  /** Pinned documents' ids: listed first, in a group of their own. */
  pinned?: string[]
  /** Groups folded or opened by hand; Archived is folded unless opened. */
  folded?: Record<string, boolean>
  hideArchived?: boolean
  /** Everything open (while searching, so every match is in sight). */
  openAll?: boolean
  types?: Vocabulary
  statuses?: Vocabulary
  now?: Date
}

/** Status values that mean a document is finished: they fold away into Archived. */
export const FINISHED = new Set(['archived', 'done'])
export const PINNED = 'pinned'
export const ARCHIVED = 'archived'

export function isFinished(doc: DocumentSummary): boolean {
  const status = doc.properties?.status
  return typeof status === 'string' && FINISHED.has(status)
}

const BUCKETS = [
  ['today', msg('Today')],
  ['week', msg('This week')],
  ['month', msg('This month')],
  ['older', msg('Older')],
] as const

/** Today (since midnight), This week (the 7 days before), This month (30 days), Older. */
export function changedBucket(iso: string, now = new Date()): (typeof BUCKETS)[number][0] {
  const d = new Date(iso).getTime()
  const daysAgo = (n: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - n).getTime()
  if (d >= daysAgo(0)) return 'today'
  if (d >= daysAgo(7)) return 'week'
  if (d >= daysAgo(30)) return 'month'
  return 'older'
}

type Group = { id: string; label: string; order: number; docs: DocumentSummary[] }

function value(doc: DocumentSummary, key: string): string {
  const v = doc.properties?.[key]
  return typeof v === 'string' ? v : ''
}

/** The group a document goes into (not counting Pinned and Archived), and where it goes. */
function groupOf(doc: DocumentSummary, by: GroupBy, o: RowOptions): Omit<Group, 'docs'> {
  if (by === 'changed') {
    const bucket = changedBucket(doc.updated_at, o.now)
    const i = BUCKETS.findIndex(([id]) => id === bucket)
    return { id: `changed:${bucket}`, label: t(BUCKETS[i][1]), order: i }
  }
  if (by === 'type' || by === 'status') {
    const slug = value(doc, by)
    const words = (by === 'type' ? o.types : o.statuses) ?? []
    if (!slug) return { id: `${by}:`, label: by === 'type' ? t('No type') : t('No status'), order: Number.MAX_SAFE_INTEGER }
    const i = words.findIndex((w) => w.slug === slug)
    // A value that isn't in the property's list comes after the known ones.
    return { id: `${by}:${slug}`, label: i >= 0 ? words[i].label : slug, order: i >= 0 ? i : words.length }
  }
  return { id: `folder:${doc.folder}`, label: doc.folder, order: 0 }
}

const SEPARATOR = /[:–—\-|/]\s/g
const MIN_PREFIX = 4

/** The starts of a title that end at a separator ("Prompt: ", "Prompt: Anemo agent – "). */
function prefixes(title: string): string[] {
  const out: string[] = []
  for (const m of title.matchAll(SEPARATOR)) {
    const end = m.index + m[0].length
    if (end >= MIN_PREFIX && end < title.length) out.push(title.slice(0, end))
  }
  return out
}

/** For each document, the longest start of its title at least one other in the group shares. */
function sharedPrefixes(docs: DocumentSummary[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const doc of docs) for (const p of prefixes(doc.title)) counts.set(p, (counts.get(p) ?? 0) + 1)
  const out = new Map<string, number>()
  for (const doc of docs) {
    const shared = prefixes(doc.title).filter((p) => (counts.get(p) ?? 0) > 1)
    if (shared.length) out.set(doc.id, shared[shared.length - 1].length)
  }
  return out
}

function sorted(docs: DocumentSummary[], by: SortBy): DocumentSummary[] {
  return [...docs].sort(by === 'changed'
    ? (a, b) => b.updated_at.localeCompare(a.updated_at) || a.title.localeCompare(b.title)
    : (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }) || a.path.localeCompare(b.path))
}

/**
 * The list as rows: Pinned first, then a heading and the documents of each group, then
 * Archived (folded unless opened). In folder groups the top level has no heading and comes
 * first; folders are by name. A folded group keeps its heading (with its count).
 */
export function listRows(docs: DocumentSummary[], o: RowOptions = {}): ListRow[] {
  const by = o.groupBy ?? 'folder'
  const sortBy = o.sortBy ?? 'title'
  const pinnedIds = new Set(o.pinned ?? [])
  const pinned: DocumentSummary[] = []
  const archived: DocumentSummary[] = []
  const groups = new Map<string, Group>()
  for (const doc of docs) {
    if (pinnedIds.has(doc.id)) pinned.push(doc)
    else if (isFinished(doc)) archived.push(doc)
    else {
      const g = groupOf(doc, by, o)
      const group = groups.get(g.id)
      if (group) group.docs.push(doc)
      else groups.set(g.id, { ...g, docs: [doc] })
    }
  }
  const ordered = [...groups.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))

  const rows: ListRow[] = []
  const add = (id: string, label: string | null, list: DocumentSummary[], foldedByDefault = false) => {
    const folded = !o.openAll && label !== null && (o.folded?.[id] ?? foldedByDefault)
    if (label !== null) rows.push({ kind: 'group', key: `group:${id}`, group: id, label, count: list.length, folded })
    if (folded) return
    const shared = sharedPrefixes(list)
    for (const doc of sorted(list, sortBy)) rows.push({ kind: 'doc', key: doc.id, doc, prefix: shared.get(doc.id) ?? 0 })
  }
  if (pinned.length) add(PINNED, t('Pinned'), pinned)
  for (const g of ordered) add(g.id, by === 'folder' && g.label === '' ? null : g.label, g.docs)
  if (archived.length && !o.hideArchived) add(ARCHIVED, t('Archived'), archived, true)
  return rows
}
