import { PageHeader } from '@/components/ui/PageHeader'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { NavLink, useNavigate, useSearchParams } from 'react-router'
import { FileText, Folder, PenLine, Plus, Search } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { promptDialog } from '@/components/ui/dialogs'
import { Lingering } from '@/components/ui/Lingering'
import { NewSketchDialog } from '@/features/sketch/NewSketchDialog'
import { cn } from '@/lib/cn'
import { formatWhen } from '@/lib/format'
import { plural, rich, t } from '@/lib/i18n'
import { listRows } from '../listRows'
import { type DocumentSummary, type SketchLayout, useCreateDocument, useDocuments, usePrefetchDocument } from '../api'

/**
 * Documents grouped by folder. New documents go into `currentFolder`. With a project
 * chosen (`projectFolder`), only the documents in that project's folder are listed;
 * with `outside`, only those in none of these projects' folders (Uncategorized).
 *
 * `?new=document` or `?new=sketch` in the address (the command palette) asks for a new one.
 */
export function DocumentList({ currentFolder, projectFolder, projectName, outside }: {
  currentFolder: string; projectFolder?: string; projectName?: string; outside?: string[]
}) {
  const navigate = useNavigate()
  const documents = useDocuments()
  const create = useCreateDocument()
  const prefetch = usePrefetchDocument()
  const [query, setQuery] = useState('')

  const everything = documents.data?.documents
  const q = query.trim().toLowerCase()
  // A key for the folders (a new array each render). JSON keeps an empty list empty:
  // joined with a separator, [] came back as [''], which hid every top-level document.
  const outsideKey = outside && JSON.stringify(outside)
  // Worked out again only when the documents, the place or the search change: the list
  // below keeps its measured rows between renders.
  const { all, rows } = useMemo(() => {
    const docs = everything ?? []
    const within = (folder: string, parent: string) => folder === parent || folder.startsWith(`${parent}/`)
    const away = outsideKey === undefined ? undefined : (JSON.parse(outsideKey) as string[])
    const all = projectFolder
      ? docs.filter((d) => within(d.folder, projectFolder))
      : away
        ? docs.filter((d) => !away.some((f) => within(d.folder, f)))
        : docs
    const shown = q ? all.filter((d) => d.title.toLowerCase().includes(q) || d.path.toLowerCase().includes(q)) : all
    return { all, rows: listRows(shown) }
  }, [everything, projectFolder, outsideKey, q])
  const scroller = useRef<HTMLElement>(null)
  const estimateSize = useCallback((i: number) => (rows[i].kind === 'folder' ? 30 : 50), [rows])
  const getItemKey = useCallback((i: number) => rows[i].key, [rows])
  // Only the rows in sight (and a few around them) are in the page: thousands of documents
  // scroll as smoothly as ten. Rows are measured as they show (a long title, density).
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize,
    getItemKey,
    overscan: 12,
  })

  const newDocument = async () => {
    const title = await promptDialog({ title: t('New document'), label: t('Title'), placeholder: t('e.g. Trip to Lisbon'), confirmLabel: t('Create') })
    if (!title) return
    create.mutate({ title, folder: currentFolder }, { onSuccess: (doc) => navigate(`/documents/${doc.id}`) })
  }
  const [newSketch, setNewSketch] = useState(false)
  const createSketch = (title: string, layout: SketchLayout) =>
    create.mutate({ title, folder: currentFolder, kind: 'sketch', layout }, {
      onSuccess: (doc) => {
        setNewSketch(false)
        navigate(`/documents/${doc.id}`)
      },
    })
  const [params, setParams] = useSearchParams()
  const asked = params.get('new')
  useEffect(() => {
    if (asked !== 'document' && asked !== 'sketch') return
    setParams((p) => { p.delete('new'); return p }, { replace: true })
    if (asked === 'sketch') setNewSketch(true)
    else void newDocument()
    // Once for each time it is asked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked])

  return (
    <div className="flex h-full flex-col">
      <PageHeader title={t('Documents')} detail={projectName ?? (outside ? t('Uncategorized') : undefined)}>
      <Button size="icon" variant="ghost" aria-label={t('New sketch')} title={t('New sketch')} onClick={() => setNewSketch(true)}>
        <PenLine className="h-4 w-4" />
      </Button>
      <Button size="sm" variant="primary" icon={<Plus className="h-4 w-4" />} loading={create.isPending && !newSketch} onClick={() => void newDocument()}>
        {t('New')}
      </Button>
      </PageHeader>
      <Lingering value={newSketch}>
        {() => <NewSketchDialog busy={create.isPending} onCreate={createSketch} onClose={() => setNewSketch(false)} />}
      </Lingering>
      <div className="relative px-3 pb-2 pt-3">
        <Search className="pointer-events-none absolute left-5.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('Find by title')} aria-label={t('Find by title')}
          className="h-9 w-full rounded-control bg-surface-2 pl-8 pr-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-accent-soft pointer-coarse:h-10" />
      </div>
      {(documents.error ?? create.error) && (
        <p className="px-3 text-[12.5px] text-error">{errorMessage(documents.error ?? create.error)}</p>
      )}
      <nav ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {documents.isSuccess && all.length === 0 && (
          <p className="px-2 py-6 text-center text-[13px] text-muted">
            {projectFolder
              ? rich('No documents in this project yet. They are Markdown files in <code>documents/{folder}</code>.', { code: (c) => <code className="font-mono">{c}</code> }, { folder: projectFolder })
              : outside && (everything?.length ?? 0) > 0
                ? t('No documents outside a project yet.')
                : rich('No documents yet. They are Markdown files in the <code>documents</code> folder of your workspace.', { code: (c) => <code className="font-mono">{c}</code> })}
          </p>
        )}
        {documents.isSuccess && all.length > 0 && rows.length === 0 && (
          <p className="px-2 py-6 text-center text-[13px] text-muted">{t('No document matches.')}</p>
        )}
        <div className="relative w-full" style={{ height: virtual.getTotalSize() }}>
          {virtual.getVirtualItems().map((item) => {
            const row = rows[item.index]
            return (
              <div key={item.key} ref={virtual.measureElement} data-index={item.index}
                className="absolute left-0 top-0 w-full" style={{ transform: `translateY(${item.start}px)` }}>
                {row.kind === 'folder' ? (
                  <div className={cn('flex items-center gap-1.5 px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-subtle', item.index > 0 && 'mt-2')}>
                    <Folder className="h-3 w-3" /> {row.folder}
                  </div>
                ) : (
                  <DocumentRow doc={row.doc} prefetch={prefetch} />
                )}
              </div>
            )
          })}
        </div>
      </nav>
    </div>
  )
}

function DocumentRow({ doc, prefetch }: { doc: DocumentSummary; prefetch: (id: string) => void }) {
  return (
    <NavLink to={`/documents/${doc.id}`}
      onPointerEnter={() => prefetch(doc.id)} onFocus={() => prefetch(doc.id)}
      className={({ isActive }) =>
        cn('flex items-start gap-2 rounded-control px-2 py-(--list-row-y) text-[13.5px] transition-colors',
          isActive ? 'bg-accent-soft text-accent' : 'hover:bg-surface-hover')}>
      {doc.kind === 'sketch'
        ? <PenLine className="mt-0.5 h-4 w-4 shrink-0 opacity-70" />
        : <FileText className="mt-0.5 h-4 w-4 shrink-0 opacity-70" />}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{doc.title}</span>
        <span className="block truncate text-[11.5px] text-muted">
          {formatWhen(doc.updated_at)} · {doc.kind === 'sketch' ? t('Drawing sheet') : plural(doc.word_count, '{n} words', '{n} words')}
          {doc.last_editor === 'agent' && ` · ${t('by an agent')}`}
          {doc.last_editor === 'extension' && ` · ${t('saved from the browser')}`}
        </span>
      </span>
    </NavLink>
  )
}
