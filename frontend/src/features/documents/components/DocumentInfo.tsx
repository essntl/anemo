import { Link, useNavigate } from 'react-router'
import { FileText, History, SquareCheckBig } from 'lucide-react'
import { useDocumentBacklinks } from '@/features/links/api'
import { cn } from '@/lib/cn'
import { formatWhen } from '@/lib/format'
import { useRevisions } from '../api'
import { outlineOf, wordCount } from '../outline'

const LABEL = 'px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-subtle'
const ROW = 'flex min-h-8 w-full items-center gap-2 rounded-control px-2 text-left text-[13px] hover:bg-surface-hover'
const AUTHORS: Record<string, string> = { user: 'You', agent: 'An agent', extension: 'The browser extension' }

/**
 * Beside a document: its outline (a heading takes you there), what it is, the documents
 * and tasks that link to it, and its latest versions. Shown and hidden with the button
 * in the editor's header.
 */
export function DocumentInfo({ documentId, path, text, onHistory }: { documentId: string; path: string; text: string; onHistory: () => void }) {
  const navigate = useNavigate()
  const outline = outlineOf(text)
  const links = useDocumentBacklinks(documentId).data
  const revisions = useRevisions(documentId, true)
  const words = wordCount(text)
  return (
    <div className="flex flex-col gap-5 p-3 pt-4">
      <section aria-label="Outline">
        <div className={LABEL}>Outline</div>
        {outline.length === 0 && <p className="px-2 text-[13px] text-muted">Headings show up here.</p>}
        {outline.map((h, i) => (
          <button key={`${h.slug}-${i}`} type="button" onClick={() => void navigate({ hash: h.slug }, { replace: true })}
            className={cn(ROW, 'text-muted hover:text-text', h.level === 1 && 'font-medium text-text', h.level === 3 && 'pl-5')}>
            <span className="min-w-0 truncate">{h.title}</span>
          </button>
        ))}
      </section>

      <section aria-label="Details">
        <div className={LABEL}>Details</div>
        <p className="break-all px-2 font-mono text-[12px] text-muted">{path}</p>
        <p className="px-2 pt-1 text-[13px]">
          {words.toLocaleString()} word{words === 1 ? '' : 's'}
          <span className="text-muted"> · about {Math.max(1, Math.round(words / 220))} min to read</span>
        </p>
      </section>

      {links && (links.documents.length > 0 || links.tasks.length > 0) && (
        <section aria-label="Linked from">
          <div className={LABEL}>Linked from</div>
          {links.documents.map((d) => (
            <Link key={d.id} to={`/documents/${d.id}`} className={ROW}>
              <FileText className="h-3.5 w-3.5 shrink-0 text-muted" /><span className="min-w-0 truncate">{d.title}</span>
            </Link>
          ))}
          {links.tasks.map((t) => (
            <Link key={t.id} to={`/tasks?task=${t.id}`} className={ROW}>
              <SquareCheckBig className="h-3.5 w-3.5 shrink-0 text-muted" /><span className="min-w-0 truncate">{t.title}</span>
            </Link>
          ))}
        </section>
      )}

      <section aria-label="History">
        <div className={LABEL}>History</div>
        {(revisions.data ?? []).slice(0, 4).map((r) => (
          <button key={r.id} type="button" onClick={onHistory} className={cn(ROW, 'min-h-11 items-start py-1.5')}>
            <History className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
            <span className="min-w-0">
              <span className="block truncate">{AUTHORS[r.author] ?? r.author}{r.current && ' · current'}</span>
              <span className="block text-[12px] text-muted">{formatWhen(r.updated_at)}</span>
            </span>
          </button>
        ))}
        {revisions.data?.length === 0 && <p className="px-2 text-[13px] text-muted">No versions yet.</p>}
        {(revisions.data?.length ?? 0) > 4 && (
          <button type="button" onClick={onHistory} className="px-2 pt-1 text-[12.5px] font-medium text-accent hover:underline">All versions</button>
        )}
      </section>
    </div>
  )
}
