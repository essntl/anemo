import { Link } from 'react-router'
import { FileText, Link2, SquareCheckBig } from 'lucide-react'
import { useDocumentBacklinks } from './api'

/** A slim bar under a document: the documents and tasks that link to it. */
export function DocumentBacklinks({ documentId }: { documentId: string }) {
  const links = useDocumentBacklinks(documentId)
  const d = links.data
  if (!d || (!d.documents.length && !d.tasks.length)) return null
  const chip = 'flex max-w-56 items-center gap-1 rounded-md border border-border bg-surface-2 px-1.5 py-0.5 hover:border-border-strong'
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-border px-4 py-2 text-[12.5px]" aria-label="Linked from">
      <span className="flex items-center gap-1 text-muted"><Link2 className="h-3.5 w-3.5" /> Linked from</span>
      {d.documents.map((x) => (
        <Link key={x.id} to={`/documents/${x.id}`} className={chip}>
          <FileText className="h-3.5 w-3.5 shrink-0 text-accent" /><span className="truncate">{x.title}</span>
        </Link>
      ))}
      {d.tasks.map((t) => (
        <Link key={t.id} to={`/tasks?task=${t.id}`} className={chip}>
          <SquareCheckBig className="h-3.5 w-3.5 shrink-0 text-accent" /><span className="truncate">{t.title}</span>
        </Link>
      ))}
    </div>
  )
}
