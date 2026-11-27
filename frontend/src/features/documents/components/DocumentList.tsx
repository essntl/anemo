import { PageHeader } from '@/components/ui/PageHeader'
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { NavLink, useNavigate, useSearchParams } from 'react-router'
import { Archive, ArchiveRestore, Bot, ChevronRight, FileText, Folder, PenLine, Pin, PinOff, Plus, Search } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { ActionMenu, type MenuAction } from '@/components/ui/ActionMenu'
import { Button } from '@/components/ui/Button'
import { promptDialog } from '@/components/ui/dialogs'
import { Lingering } from '@/components/ui/Lingering'
import { Select } from '@/components/ui/Select'
import { toast } from '@/components/ui/toast'
import { type PropertyDefinition, useProperties, valueLabel } from '@/features/properties/api'
import { NewSketchDialog } from '@/features/sketch/NewSketchDialog'
import { cn } from '@/lib/cn'
import { formatAge, formatDateTime } from '@/lib/format'
import { rich, t } from '@/lib/i18n'
import { ARCHIVED, isFinished, type ListRow, listRows, PINNED, type Vocabulary } from '../listRows'
import { type GroupBy, OUTSIDE, type SortBy, useDocListStore, useListView } from '../docListStore'
import { useDocumentPins } from '../usePins'
import { type DocumentSummary, type SketchLayout, useArchiveDocument, useCreateDocument, useDocuments, usePrefetchDocument } from '../api'

const vocabulary = (d: PropertyDefinition | undefined): Vocabulary => (d?.options ?? []).map((o) => ({ slug: o.slug, label: o.label }))

/**
 * The documents of the place being looked at, in groups (docs/specs/26-document-organisation.md):
 * Pinned first, then by folder, type, status or last change, then Archived (folded). New
 * documents go into `currentFolder`. With a project chosen (`projectFolder`), only the
 * documents in that project's folder are listed; with `outside`, only those in none of
 * these projects' folders (Uncategorized).
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
  const archive = useArchiveDocument()
  const properties = useProperties()
  const pins = useDocumentPins()
  const place = pins.projectId ?? OUTSIDE
  const view = useListView(place)
  const changeView = useDocListStore((s) => s.change)
  const fold = useDocListStore((s) => s.fold)
  const [query, setQuery] = useState('')
  const [menuFor, setMenuFor] = useState<string | null>(null)

  const everything = documents.data?.documents
  const q = query.trim().toLowerCase()
  // A key for the folders (a new array each render). JSON keeps an empty list empty:
  // joined with a separator, [] came back as [''], which hid every top-level document.
  const outsideKey = outside && JSON.stringify(outside)
  const definitions = properties.data
  const byKey = useMemo(() => new Map((definitions ?? []).map((d) => [d.key, d])), [definitions])
  const { groupBy, sortBy, folded, hideArchived } = view
  // Worked out again only when the documents, the place, the view or the search change:
  // the list below keeps its measured rows between renders.
  const { all, rows, archivedCount } = useMemo(() => {
    const docs = everything ?? []
    const within = (folder: string, parent: string) => folder === parent || folder.startsWith(`${parent}/`)
    const away = outsideKey === undefined ? undefined : (JSON.parse(outsideKey) as string[])
    const all = projectFolder
      ? docs.filter((d) => within(d.folder, projectFolder))
      : away
        ? docs.filter((d) => !away.some((f) => within(d.folder, f)))
        : docs
    const shown = q ? all.filter((d) => d.title.toLowerCase().includes(q) || d.path.toLowerCase().includes(q)) : all
    const rows = listRows(shown, {
      groupBy, sortBy, folded, hideArchived, pinned: pins.ids, openAll: Boolean(q),
      types: vocabulary(byKey.get('type')), statuses: vocabulary(byKey.get('status')),
    })
    return { all, rows, archivedCount: all.filter(isFinished).length }
  }, [everything, projectFolder, outsideKey, q, groupBy, sortBy, folded, hideArchived, pins.ids, byKey])
  const scroller = useRef<HTMLElement>(null)
  const estimateSize = useCallback((i: number) => (rows[i].kind === 'group' ? 30 : 56), [rows])
  const getItemKey = useCallback((i: number) => rows[i].key, [rows])
  // Only the rows in sight (and a few around them) are in the page: thousands of documents
  // scroll as smoothly as ten. Rows are measured as they show (two-line titles, density).
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize,
    getItemKey,
    overscan: 12,
  })

  // Up and down move between rows, also to rows not drawn yet (they are scrolled to first).
  const moveFocus = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-index]')
    if (!row) return
    const next = Number(row.dataset.index) + (e.key === 'ArrowDown' ? 1 : -1)
    if (next < 0 || next >= rows.length) return
    e.preventDefault()
    virtual.scrollToIndex(next, { align: 'auto' })
    const focus = (tries: number) => {
      const target = scroller.current?.querySelector<HTMLElement>(`[data-index="${next}"] [data-row-focus]`)
      if (target) target.focus()
      else if (tries > 0) requestAnimationFrame(() => focus(tries - 1))
    }
    focus(3)
  }

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

  const actionsFor = (doc: DocumentSummary): MenuAction[] => {
    const finished = isFinished(doc)
    const pinned = pins.isPinned(doc.id)
    return [
      { label: pinned ? t('Unpin') : t('Pin to the top'), icon: pinned ? <PinOff /> : <Pin />, onSelect: () => pins.toggle(doc.id) },
      {
        label: finished ? t('Unarchive') : t('Archive'), icon: finished ? <ArchiveRestore /> : <Archive />,
        onSelect: () => archive.mutate({ id: doc.id, archived: !finished }, {
          onSuccess: () => toast({ message: finished ? t('“{title}” is active again.', { title: doc.title }) : t('“{title}” is archived.', { title: doc.title }) }),
          onError: (err) => toast({ message: errorMessage(err) }),
        }),
      },
    ]
  }

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
      <div className="relative px-3 pt-3">
        <Search className="pointer-events-none absolute left-5.5 top-[calc(50%+0.375rem)] h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('Find by title')} aria-label={t('Find by title')}
          className="h-9 w-full rounded-control bg-surface-2 pl-8 pr-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-accent-soft pointer-coarse:h-10" />
      </div>
      <div className="flex flex-wrap items-center gap-0.5 px-2 pb-1 pt-1">
        <Select variant="ghost" aria-label={t('Group by')} value={groupBy} onValueChange={(v) => changeView(place, { groupBy: v as GroupBy })}
          options={[
            { value: 'folder', label: t('Group by folder') },
            { value: 'type', label: t('Group by type') },
            { value: 'status', label: t('Group by status') },
            { value: 'changed', label: t('Group by last change') },
          ]} />
        <Select variant="ghost" aria-label={t('Sort')} value={sortBy} onValueChange={(v) => changeView(place, { sortBy: v as SortBy })}
          options={[
            { value: 'title', label: t('Sort by title') },
            { value: 'changed', label: t('Sort by last change') },
          ]} />
        {(archivedCount > 0 || hideArchived) && (
          <Button size="icon" variant="ghost" className="ml-auto h-8 w-8" aria-pressed={hideArchived}
            aria-label={hideArchived ? t('Show archived documents') : t('Hide archived documents')}
            title={hideArchived ? t('Show archived documents') : t('Hide archived documents')}
            onClick={() => changeView(place, { hideArchived: !hideArchived })}>
            <Archive className={cn('h-4 w-4', hideArchived && 'opacity-40')} />
          </Button>
        )}
      </div>
      {(documents.error ?? create.error) && (
        <p className="px-3 text-[12.5px] text-error">{errorMessage(documents.error ?? create.error)}</p>
      )}
      <nav ref={scroller} onKeyDown={moveFocus} className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
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
                {row.kind === 'group' ? (
                  <GroupHeading row={row} groupBy={groupBy} first={item.index === 0} onToggle={() => fold(place, row.group, !row.folded)} />
                ) : (
                  <DocumentRow doc={row.doc} prefix={row.prefix} prefetch={prefetch} definitions={byKey}
                    actions={actionsFor(row.doc)} menuOpen={menuFor === row.doc.id}
                    onMenu={(open) => setMenuFor(open ? row.doc.id : null)} />
                )}
              </div>
            )
          })}
        </div>
      </nav>
    </div>
  )
}

function GroupHeading({ row, groupBy, first, onToggle }: {
  row: Extract<ListRow, { kind: 'group' }>; groupBy: GroupBy; first: boolean; onToggle: () => void
}) {
  const icon = row.group === PINNED ? <Pin className="h-3 w-3" />
    : row.group === ARCHIVED ? <Archive className="h-3 w-3" />
      : groupBy === 'folder' ? <Folder className="h-3 w-3" /> : null
  return (
    <button type="button" data-row-focus aria-expanded={!row.folded} onClick={onToggle}
      className={cn('flex w-full items-center gap-1.5 rounded-control px-2 pb-1 pt-2 text-left text-[11px] font-semibold uppercase tracking-wider text-subtle hover:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft', !first && 'mt-2')}>
      <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', !row.folded && 'rotate-90')} />
      {icon}
      <span className="min-w-0 truncate">{row.label}</span>
      <span className="ml-auto shrink-0 font-medium tabular-nums">{row.count}</span>
    </button>
  )
}

/**
 * A document: its title on up to two lines (a prefix the group shares is fainter), then
 * its status and type and how old the last change is. What doesn't fit on that line
 * drops out whole, from the end; the age always stays.
 */
function DocumentRow({ doc, prefix, prefetch, definitions, actions, menuOpen, onMenu }: {
  doc: DocumentSummary
  prefix: number
  prefetch: (id: string) => void
  definitions: Map<string, PropertyDefinition>
  actions: MenuAction[]
  menuOpen: boolean
  onMenu: (open: boolean) => void
}) {
  const props = doc.properties ?? {}
  const chip = (key: string) => {
    const value = props[key]
    if (typeof value !== 'string' || !value) return null
    return <span key={key} className="whitespace-nowrap rounded-full bg-surface-2 px-1.5 leading-[18px]">{valueLabel(definitions.get(key), value)}</span>
  }
  const parts = [isFinished(doc) ? null : chip('status'), chip('type')]
  return (
    <div className="group relative" onContextMenu={(e) => { e.preventDefault(); onMenu(true) }}>
      <NavLink to={`/documents/${doc.id}`} data-row-focus title={doc.title}
        onPointerEnter={() => prefetch(doc.id)} onFocus={() => prefetch(doc.id)}
        className={({ isActive }) =>
          cn('flex items-start gap-2 rounded-control py-(--list-row-y) pl-2 pr-8 text-[13.5px] transition-colors',
            isActive ? 'bg-accent-soft text-accent' : 'hover:bg-surface-hover')}>
        {doc.kind === 'sketch'
          ? <><PenLine aria-hidden className="mt-0.5 h-4 w-4 shrink-0 opacity-70" /><span className="sr-only">{t('Drawing sheet')}</span></>
          : <FileText aria-hidden className="mt-0.5 h-4 w-4 shrink-0 opacity-70" />}
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 break-words font-medium leading-snug">
            {prefix > 0 && <span className="font-normal opacity-60">{doc.title.slice(0, prefix)}</span>}
            {doc.title.slice(prefix)}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
            <span className="flex h-[18px] min-w-0 flex-1 flex-wrap gap-1 overflow-hidden">
              {parts}
              {doc.last_editor === 'agent' && (
                <span className="flex h-[18px] items-center" title={t('Last changed by an agent')} aria-label={t('Last changed by an agent')}>
                  <Bot className="h-3 w-3" />
                </span>
              )}
            </span>
            <time dateTime={doc.updated_at} title={formatDateTime(doc.updated_at)} className="shrink-0 tabular-nums">{formatAge(doc.updated_at)}</time>
          </span>
        </span>
      </NavLink>
      <ActionMenu actions={actions} label={t('Actions for {title}', { title: doc.title })} open={menuOpen} onOpenChange={onMenu}
        className="absolute right-0 top-0 h-8 w-8 opacity-0 focus:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100" />
    </div>
  )
}
