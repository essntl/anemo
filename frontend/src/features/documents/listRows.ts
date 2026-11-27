import type { DocumentSummary } from './api'

export type ListRow = { kind: 'folder'; key: string; folder: string } | { kind: 'doc'; key: string; doc: DocumentSummary }

/** The list as rows: each folder's name (none for the top level), then its documents; folders by name. */
export function listRows(docs: DocumentSummary[]): ListRow[] {
  const groups = new Map<string, DocumentSummary[]>()
  for (const doc of docs) {
    const group = groups.get(doc.folder)
    if (group) group.push(doc)
    else groups.set(doc.folder, [doc])
  }
  const rows: ListRow[] = []
  for (const folder of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
    if (folder) rows.push({ kind: 'folder', key: `folder:${folder}`, folder })
    for (const doc of groups.get(folder)!) rows.push({ kind: 'doc', key: doc.id, doc })
  }
  return rows
}

