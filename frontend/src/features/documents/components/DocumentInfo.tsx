import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { FileText, History, SquareCheckBig } from 'lucide-react'
import { useDocumentBacklinks } from '@/features/links/api'
import { cn } from '@/lib/cn'
import { formatWhen } from '@/lib/format'
import { useRevisions } from '../api'
import type { OutlineItem } from '../outline'

type Tab = 'outline' | 'details'

const LABEL = 'px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-subtle'
const ROW = 'flex min-h-8 w-full items-center gap-2 rounded-control px-2 text-left text-[13px] hover:bg-surface-hover'
const AUTHORS: Record<string, string> = { user: 'You', agent: 'An agent', extension: 'The browser extension' }

/** How a heading of each level is set in the outline: size, weight, colour and how far in. */
const LEVEL: Record<number, string> = {
  1: 'mt-2 pl-2 text-[13px] font-semibold text-text first:mt-0',
  2: 'pl-5 text-[13px] text-text',
  3: 'pl-8 text-[12.5px] text-muted',
}

/** The document's headings as a tree: a click goes there, and the one being read is marked. */
function Outline({ outline, active, onJump }: { outline: OutlineItem[]; active: number; onJump: (index: number) => void }) {
  const list = useRef<HTMLElement>(null)
  // The marked heading stays in sight while the document scrolls.
  useEffect(() => {
    list.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])
  if (outline.length === 0) {
    return <p className="p-4 text-[13px] text-muted">Headings show up here. Use H1, H2 and H3 in the toolbar to give the document a structure.</p>
  }
  return (
    <nav ref={list} aria-label="Outline" className="min-h-0 flex-1 overflow-y-auto p-2">
      {outline.map((h, i) => (
        <button key={`${h.line}-${h.slug}`} type="button" onClick={() => onJump(i)} title={h.title} aria-current={i === active ? 'true' : undefined}
          className={cn('relative flex min-h-8 w-full items-center rounded-control py-1 pr-2 text-left leading-snug hover:bg-surface-hover', LEVEL[h.level],
            // Under a top-level heading the rest hangs on a thin line, so the levels read at a glance.
            h.level > 1 && 'before:absolute before:inset-y-0 before:left-[9px] before:w-px before:bg-border',
            i === active && 'bg-accent-soft font-medium text-accent hover:bg-accent-soft before:w-0.5 before:bg-accent')}>
          <span className="line-clamp-2">{h.title}</span>
        </button>
      ))}
    </nav>
  )
}

/** What the document is, what links to it and its latest versions. */
function Details({ documentId, path, words, onHistory }: { documentId: string; path: string; words: number; onHistory: () => void }) {
  const links = useDocumentBacklinks(documentId).data
  const revisions = useRevisions(documentId, true)
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-3">
      <section aria-label="File">
        <div className={LABEL}>File</div>
        <p className="break-all px-2 font-mono text-[12px] text-muted">{path}</p>
        <p className="px-2 pt-1 text-[13px]">
          {words.toLocaleString()} word{words === 1 ? '' : 's'}
          <span className="text-muted"> · about {Math.max(1, Math.round(words / 220))} min to read</span>
        </p>
      </section>

      <section aria-label="Linked from">
        <div className={LABEL}>Linked from</div>
        {links && links.documents.length === 0 && links.tasks.length === 0 && <p className="px-2 text-[13px] text-muted">No document or task links here yet.</p>}
        {links?.documents.map((d) => (
          <Link key={d.id} to={`/documents/${d.id}`} className={ROW}>
            <FileText className="h-3.5 w-3.5 shrink-0 text-muted" /><span className="min-w-0 truncate">{d.title}</span>
          </Link>
        ))}
        {links?.tasks.map((t) => (
          <Link key={t.id} to={`/tasks?task=${t.id}`} className={ROW}>
            <SquareCheckBig className="h-3.5 w-3.5 shrink-0 text-muted" /><span className="min-w-0 truncate">{t.title}</span>
          </Link>
        ))}
      </section>

      <section aria-label="History">
        <div className={LABEL}>History</div>
        {(revisions.data ?? []).slice(0, 6).map((r) => (
          <button key={r.id} type="button" onClick={onHistory} className={cn(ROW, 'min-h-11 items-start py-1.5')}>
            <History className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
            <span className="min-w-0">
              <span className="block truncate">{AUTHORS[r.author] ?? r.author}{r.current && ' · current'}</span>
              <span className="block text-[12px] text-muted">{formatWhen(r.updated_at)}</span>
            </span>
          </button>
        ))}
        {revisions.data?.length === 0 && <p className="px-2 text-[13px] text-muted">No versions yet.</p>}
        {(revisions.data?.length ?? 0) > 6 && (
          <button type="button" onClick={onHistory} className="px-2 pt-1 text-[12.5px] font-medium text-accent hover:underline">All versions</button>
        )}
      </section>
    </div>
  )
}

/**
 * Beside a document: its outline on one tab, and on the other what the file is, what
 * links to it and its latest versions. Two tabs, so a long outline is never mixed up
 * with the rest. Shown and hidden with the button in the editor's header.
 */
export function DocumentInfo({ documentId, path, words, outline, active, onJump, onHistory }: {
  documentId: string
  path: string
  words: number
  outline: OutlineItem[]
  /** The outline item being read under, or -1. */
  active: number
  onJump: (index: number) => void
  onHistory: () => void
}) {
  const [tab, setTab] = useState<Tab>('outline')
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border p-2">
        <div role="tablist" aria-label="About this document" className="flex rounded-lg bg-surface-2 p-0.5">
          {([['outline', 'Outline'], ['details', 'Details']] as const).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
              className={cn('flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md text-[12.5px] font-medium transition-colors',
                tab === id ? 'bg-surface text-text shadow-soft' : 'text-muted hover:text-text')}>
              {label}
              {id === 'outline' && outline.length > 0 && <span className="text-[11px] font-normal tabular-nums text-subtle">{outline.length}</span>}
            </button>
          ))}
        </div>
      </div>
      {tab === 'outline'
        ? <Outline outline={outline} active={active} onJump={onJump} />
        : <Details documentId={documentId} path={path} words={words} onHistory={onHistory} />}
    </div>
  )
}
