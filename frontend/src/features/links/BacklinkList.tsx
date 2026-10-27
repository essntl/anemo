import { Link } from 'react-router'
import { FileText, Link2, SquareCheckBig } from 'lucide-react'
import type { Backlinks } from './api'

/** "Used in" / "Linked from": the tasks and documents that point at something. */
export function BacklinkList({ title, links, empty }: { title: string; links: Backlinks | undefined; empty?: string }) {
  const count = (links?.tasks.length ?? 0) + (links?.documents.length ?? 0)
  if (!links || (!count && !empty)) return null
  return (
    <section aria-label={title}>
      <h3 className="mb-1 flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-wider text-muted">
        <Link2 className="h-3.5 w-3.5" /> {title}
      </h3>
      {!count ? (
        <p className="text-[12.5px] text-muted">{empty}</p>
      ) : (
        <ul className="flex flex-col">
          {links.documents.map((d) => (
            <li key={d.id}>
              <Link to={`/documents/${d.id}`} className="flex items-center gap-2 rounded-control px-1.5 py-1 text-[13px] hover:bg-surface-hover">
                <FileText className="h-3.5 w-3.5 shrink-0 text-accent" /> <span className="truncate">{d.title}</span>
              </Link>
            </li>
          ))}
          {links.tasks.map((t) => (
            <li key={t.id}>
              <Link to={`/tasks?task=${t.id}`} className="flex items-center gap-2 rounded-control px-1.5 py-1 text-[13px] hover:bg-surface-hover">
                <SquareCheckBig className="h-3.5 w-3.5 shrink-0 text-accent" />
                <span className={t.status === 'done' ? 'truncate text-muted line-through' : 'truncate'}>{t.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
