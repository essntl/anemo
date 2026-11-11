/**
 * File manager for the AI workspace: the same folders agents work in.
 * The URL holds the state (?path=folder&file=path) so views can be linked and reloaded.
 */
import { PageHeader } from '@/components/ui/PageHeader'
import { useEffect, useState, type DragEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import {
  ChevronRight,
  ClipboardPaste,
  Copy,
  Download,
  File,
  FilePlus,
  Folder,
  FolderKanban,
  FolderPlus,
  HardDrive,
  Pencil,
  Scissors,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { errorMessage } from '@/api/client'
import { useCurrentProject, useScope } from '@/app/projectStore'
import { ActionMenu } from '@/components/ui/ActionMenu'
import { Button } from '@/components/ui/Button'
import { chooseDialog, confirmDialog, promptDialog } from '@/components/ui/dialogs'
import { EmptyState } from '@/components/ui/EmptyState'
import { toast } from '@/components/ui/toast'
import { useProjects } from '@/features/tasks/api'
import { BacklinkList } from '@/features/links/BacklinkList'
import { fileBacklinks, linkedFromText, useFileBacklinks } from '@/features/links/api'
import { api } from '@/api/client'
import { useShortcut } from '@/hooks/useShortcut'
import { cn } from '@/lib/cn'
import { formatSize } from '@/lib/format'
import { dateLocale, rich, t } from '@/lib/i18n'
import {
  downloadUrl,
  type Entry,
  joinPath,
  parentOf,
  useFileSearch,
  useFolder,
  useCopy,
  useMakeFolder,
  useMove,
  useSaveFile,
  useTrashPath,
  useUpload,
} from './api'
import { cannotPaste, useClipboard } from './clipboard'
import { FilePreview } from './components/FilePreview'
import { TrashDialog } from './components/TrashDialog'

function Breadcrumbs({ path, onOpen }: { path: string; onOpen: (path: string) => void }) {
  const parts = path ? path.split('/') : []
  return (
    <div className="flex min-w-0 items-center gap-1 text-[13px]">
      <button type="button" onClick={() => onOpen('')} className="flex shrink-0 items-center gap-1.5 rounded px-1.5 py-1 font-medium hover:bg-surface-hover">
        <HardDrive className="h-4 w-4 text-muted" /> {t('Workspace')}
      </button>
      {parts.map((part, i) => (
        <span key={i} className="flex min-w-0 items-center gap-1">
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-subtle" />
          <button type="button" onClick={() => onOpen(parts.slice(0, i + 1).join('/'))}
            className="truncate rounded px-1.5 py-1 hover:bg-surface-hover">
            {part}
          </button>
        </span>
      ))}
    </div>
  )
}

/**
 * Moves a file or folder into a project: a document (anything under documents/) into
 * the project's documents folder, anything else into its files folder.
 */
function useMoveToProject(onShowFolder: (path: string) => void) {
  const projects = useProjects()
  const move = useMove()
  const run = async (entry: Entry) => {
    const active = (projects.data ?? []).filter((p) => !p.archived)
    const isDocument = entry.path === 'documents' || entry.path.startsWith('documents/')
    const folderOf = (p: (typeof active)[number]) => (isDocument ? p.documents_path : p.files_path)
    const chosen = await chooseDialog({
      title: t('Move “{name}” to a project', { name: entry.name }),
      message: isDocument ? t('It goes into the project’s documents.') : t('It goes into the project’s files.'),
      empty: t('There are no projects yet. Create one under Projects.'),
      options: active.map((p) => ({
        value: p.id,
        label: p.name,
        hint: folderOf(p),
        icon: <span className="block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: p.color }} />,
        disabled: parentOf(entry.path) === folderOf(p),
      })),
    })
    const project = active.find((p) => p.id === chosen)
    if (!project) return
    const folder = folderOf(project)
    // mutateAsync: the row is gone from this folder before the answer arrives.
    void move.mutateAsync({ source: entry.path, destination: joinPath(folder, entry.name), keep_both: true }).then(
      () => toast({ message: t('Moved to {name}.', { name: project.name }), action: { label: t('Show'), onClick: () => onShowFolder(folder) } }),
      (err: unknown) => toast({ message: errorMessage(err) }),
    )
  }
  return { run, error: move.error }
}

function Row({ entry, selected, onOpen, showPath, onShowFolder }: {
  entry: Entry
  selected: boolean
  onOpen: () => void
  showPath?: boolean
  onShowFolder: (path: string) => void
}) {
  const move = useMove()
  const trash = useTrashPath()
  const toProject = useMoveToProject(onShowFolder)
  const clipboard = useClipboard()
  const folder = parentOf(entry.path)
  const isCut = clipboard.mode === 'cut' && clipboard.item?.path === entry.path

  const rename = async () => {
    const name = await promptDialog({
      title: entry.is_dir ? t('Rename folder') : t('Rename file'), label: t('New name'), initial: entry.name,
      selectName: !entry.is_dir, confirmLabel: t('Rename'),
    })
    if (name && name !== entry.name) move.mutate({ source: entry.path, destination: joinPath(folder, name) })
  }
  const cut = () => clipboard.put(entry, 'cut')
  const copy = () => clipboard.put(entry, 'copy')
  const remove = async () => {
    // Say where it is used first: tasks and documents that link to it.
    const used = await fileBacklinks(entry.path).then(linkedFromText, () => null)
    const ok = await confirmDialog({
      title: t('Move "{name}" to the trash?', { name: entry.name }),
      message: used ? t('{used} Those links stop working until you restore it from Trash.', { used }) : t('You can restore it from Trash later.'),
      confirmLabel: t('Move to trash'), danger: true,
    })
    if (ok) trash.mutate(entry.path)
  }
  const error = move.error ?? trash.error ?? toProject.error
  const icon = 'rounded p-1.5 text-muted hover:bg-surface-2 hover:text-text'

  return (
    <div
      onDoubleClick={onOpen}
      className={cn('group flex items-center gap-3 border-b border-border px-4 py-2 text-[13px] last:border-0 max-md:py-1 max-md:pr-1 max-md:text-[15px]',
        selected ? 'bg-accent-soft' : 'hover:bg-surface-hover', isCut && 'opacity-50')}
    >
      {entry.is_dir ? <Folder className="h-4 w-4 shrink-0 fill-accent/20 text-accent" /> : <File className="h-4 w-4 shrink-0 text-muted" />}
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 truncate py-1.5 text-left">
        {showPath ? entry.path : entry.name}
        {error && <span className="ml-2 text-[12px] text-error">{errorMessage(error)}</span>}
      </button>
      <span className="hidden w-20 text-right text-[12px] text-muted sm:block">{entry.is_dir ? '' : formatSize(entry.size, { kbDecimals: 1 })}</span>
      <span className="hidden w-36 text-right text-[12px] text-muted md:block">{new Date(entry.modified).toLocaleString(dateLocale())}</span>
      {/* Desktop: icons appear on hover (always on touch screens). Phones: a "⋯" menu. */}
      <span className="hidden w-48 justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 pointer-coarse:opacity-100 md:flex">
        {!entry.is_dir && (
          <a href={downloadUrl(entry.path)} download aria-label={t('Download')} title={t('Download')} className={icon}>
            <Download className="h-3.5 w-3.5" />
          </a>
        )}
        <button type="button" aria-label={t('Cut')} title={t('Cut (then paste in another folder)')} onClick={cut} className={icon}><Scissors className="h-3.5 w-3.5" /></button>
        <button type="button" aria-label={t('Copy')} title={t('Copy (then paste in a folder)')} onClick={copy} className={icon}><Copy className="h-3.5 w-3.5" /></button>
        <button type="button" aria-label={t('Rename')} title={t('Rename')} onClick={() => void rename()} className={icon}><Pencil className="h-3.5 w-3.5" /></button>
        <button type="button" aria-label={t('Move to a project')} title={t('Move to a project')} onClick={() => void toProject.run(entry)} className={icon}><FolderKanban className="h-3.5 w-3.5" /></button>
        <button type="button" aria-label={t('Delete')} title={t('Move to trash')} onClick={() => void remove()} className={cn(icon, 'hover:text-error')}><Trash2 className="h-3.5 w-3.5" /></button>
      </span>
      <ActionMenu
        className="md:hidden"
        label={t('Actions for {name}', { name: entry.name })}
        actions={[
          ...(entry.is_dir ? [] : [{ label: t('Download'), icon: <Download />, download: downloadUrl(entry.path) }]),
          { label: t('Cut'), icon: <Scissors />, onSelect: cut },
          { label: t('Copy'), icon: <Copy />, onSelect: copy },
          { label: t('Rename'), icon: <Pencil />, onSelect: () => void rename() },
          { label: t('Move to a project'), icon: <FolderKanban />, onSelect: () => void toProject.run(entry) },
          { label: t('Move to trash'), icon: <Trash2 />, onSelect: () => void remove(), danger: true },
        ]}
      />
    </div>
  )
}

/** What was cut or copied, with "Paste here" for the folder you are in. */
function PasteBar({ folder }: { folder: string }) {
  const { item, mode, clear } = useClipboard()
  const move = useMove()
  const copy = useCopy()
  const why = item ? cannotPaste(item, mode, folder, parentOf(item.path)) : t('Nothing to paste')
  const paste = () => {
    if (!item || why) return
    const body = { source: item.path, destination: joinPath(folder, item.name), keep_both: true }
    if (mode === 'cut') move.mutate(body, { onSuccess: clear })
    else copy.mutate(body)
  }
  // Ctrl+V / Cmd+V pastes too, Escape cancels (not while typing somewhere).
  useShortcut('files.paste', paste, { enabled: Boolean(item), whileTyping: false, keepDefault: true })
  useShortcut('files.cancelPaste', clear, { enabled: Boolean(item), keepDefault: true })
  if (!item) return null
  const error = move.error ?? copy.error
  // The name is drawn by <name> (it is not part of the translated text).
  const hintParts = {
    name: () => <span className="font-medium">{item.name}</span>,
    rest: (c: string) => <span className="text-muted">{c}</span>,
  }
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-accent-soft/40 px-4 py-2 text-[13px]" role="status">
      {mode === 'cut' ? <Scissors className="h-4 w-4 shrink-0 text-accent" /> : <Copy className="h-4 w-4 shrink-0 text-accent" />}
      <span className="min-w-0 flex-1 truncate">
        {mode === 'cut'
          ? rich('<name></name><rest> cut: open the folder it should go to, then paste</rest>', hintParts)
          : rich('<name></name><rest> copied: open the folder it should go to, then paste</rest>', hintParts)}
        {error && <span className="ml-2 text-error">{errorMessage(error)}</span>}
      </span>
      <Button size="sm" variant="primary" icon={<ClipboardPaste className="h-3.5 w-3.5" />} disabled={Boolean(why)}
        title={why ?? t('Paste here (Ctrl+V)')} loading={move.isPending || copy.isPending} onClick={paste}>
        {t('Paste here')}
      </Button>
      <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />} onClick={clear}>{t('Cancel')}</Button>
    </div>
  )
}

/** Where a file is used, under its preview. */
function UsedIn({ path }: { path: string }) {
  const links = useFileBacklinks(path)
  if (!links.data || (!links.data.tasks.length && !links.data.documents.length)) return null
  return (
    <div className="max-h-48 shrink-0 overflow-y-auto border-t border-border px-4 py-3">
      <BacklinkList title={t('Used in')} links={links.data} />
    </div>
  )
}

export function FilesPage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  // With a project chosen in the sidebar, the file manager starts in its folder.
  // '.' in the address means the workspace root (so you can still go up from there).
  const project = useCurrentProject()
  const requested = params.get('path')
  const path = requested === '.' ? '' : (requested ?? project?.files_path ?? '')
  const openFile = params.get('file')
  const [query, setQuery] = useState('')
  const [trashOpen, setTrashOpen] = useState(false)
  const [dragging, setDragging] = useState(false)

  const folder = useFolder(path)
  const search = useFileSearch(query.trim())
  const makeFolder = useMakeFolder()
  const saveFile = useSaveFile()
  const upload = useUpload()

  const go = (next: { path?: string; file?: string | null }) => {
    const p = new URLSearchParams()
    const nextPath = next.path ?? path
    if (nextPath) p.set('path', nextPath)
    else if (project) p.set('path', '.')
    const nextFile = next.file === undefined ? openFile : next.file
    if (nextFile) p.set('file', nextFile)
    setParams(p)
  }
  const open = (entry: Entry) => {
    if (entry.is_dir) {
      setQuery('')
      go({ path: entry.path, file: null })
    } else {
      go({ path: parentOf(entry.path), file: entry.path })
    }
  }

  const newFolder = async () => {
    const name = await promptDialog({ title: t('New folder'), label: t('Folder name'), confirmLabel: t('Create') })
    if (name) makeFolder.mutate(joinPath(path, name))
  }
  const newFile = async () => {
    const name = await promptDialog({
      title: t('New file'), label: t('File name'), initial: 'untitled.md', selectName: true, confirmLabel: t('Create'),
    })
    if (!name) return
    try {
      const saved = await saveFile.mutateAsync({ path: joinPath(path, name), content: '', base_hash: null })
      go({ file: saved.path })
    } catch (err) {
      toast({ message: errorMessage(err) }) // e.g. a file with that name exists
    }
  }
  const pickFiles = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.onchange = () => input.files && upload.mutate({ folder: path, files: Array.from(input.files) })
    input.click()
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (e.dataTransfer.files.length) upload.mutate({ folder: path, files: Array.from(e.dataTransfer.files) })
  }

  // A link to a file (/files?path=<file>, from a document or task) opens its folder with
  // the file shown.
  const notAFolder = folder.isError && !!requested && requested !== '.'
  useEffect(() => {
    if (!notAFolder || !requested) return
    void api.GET('/api/files', { params: { query: { path: parentOf(requested) } } }).then(({ data }) => {
      const hit = data?.entries.find((e) => e.path === requested && !e.is_dir)
      if (hit) setParams(new URLSearchParams({ path: parentOf(requested) || '.', file: requested }), { replace: true })
    })
  }, [notAFolder, requested, setParams])
  // Pages of the Documents library open in the Documents editor, never as plain text.
  useEffect(() => {
    if (!openFile?.startsWith('documents/') || !openFile.endsWith('.md')) return
    void api.GET('/api/documents/by-path', { params: { query: { path: openFile } } }).then(({ data }) => {
      if (data) void navigate(`/documents/${data.id}`, { replace: true })
    })
  }, [openFile, navigate])

  const searching = query.trim().length > 0
  // A file open beside the list leaves the list's header half the room.
  const compact = Boolean(openFile)
  // Uncategorized: the projects' own folders (and, in a search, what is in them) stay out of
  // sight, unless you are inside one of them (a link led there).
  const scope = useScope()
  const allProjects = useProjects()
  const projectFolders = scope.kind === 'uncategorized' ? (allProjects.data ?? []).flatMap((p) => [p.files_path, p.documents_path]) : []
  const under = (p: string, parent: string) => p === parent || p.startsWith(`${parent}/`)
  const insideProject = projectFolders.some((f) => under(path, f))
  const listed = searching ? (search.data ?? []) : (folder.data?.entries ?? [])
  const entries = insideProject ? listed : listed.filter((e) => !projectFolders.some((f) => under(e.path, f)))
  const selectedEntry = openFile ? entries.find((e) => e.path === openFile) ?? {
    name: openFile.split('/').pop() ?? openFile, path: openFile, is_dir: false, size: 0, modified: '', mime: null,
  } : null
  const error = (notAFolder ? null : folder.error) ?? makeFolder.error ?? saveFile.error ?? upload.error

  return (
    // From `md` up the file manager is one panel on the ground, like the sidebar.
    <div className="flex h-full md:mx-3 md:mb-3 md:h-[calc(100%-0.75rem)] md:overflow-hidden md:rounded-panel md:border md:border-border md:bg-surface md:shadow-soft">
      <PageHeader title={t('Files')} />
      <div className={cn('flex min-w-0 flex-1 flex-col', openFile && 'hidden lg:flex')}>
        <header className="flex flex-wrap items-center gap-x-1 gap-y-2 border-b border-border px-3 py-2.5 md:gap-2 md:px-4">
          {/* The path keeps at least this width: when the row is short (a file is open beside it), the rest wraps under it. */}
          <div className="w-full min-w-0 overflow-hidden md:w-auto md:min-w-48 md:flex-1"><Breadcrumbs path={path} onOpen={(p) => go({ path: p, file: null })} /></div>
          <div className="relative order-last w-full md:order-none md:w-auto">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('Find by name')}
              className="h-8 w-full rounded-control bg-surface-2 pl-8 pr-2 text-[12.5px] focus:outline-none focus:ring-2 focus:ring-accent-soft pointer-coarse:h-10 md:w-44" />
          </div>
          {/* With a file open beside the list the buttons are icons only (they keep their names for screen readers, with a tooltip). */}
          <Button size="sm" variant="ghost" className={cn(compact && 'px-2')} aria-label={t('File')} title={t('New file')} icon={<FilePlus className="h-3.5 w-3.5" />} onClick={() => void newFile()}>{!compact && t('File')}</Button>
          <Button size="sm" variant="ghost" className={cn(compact && 'px-2')} aria-label={t('Folder')} title={t('New folder')} icon={<FolderPlus className="h-3.5 w-3.5" />} onClick={() => void newFolder()}>{!compact && t('Folder')}</Button>
          <Button size="sm" variant="secondary" className={cn(compact && 'px-2')} aria-label={t('Upload')} title={t('Upload files')} icon={<Upload className="h-3.5 w-3.5" />} loading={upload.isPending} onClick={pickFiles}>{!compact && t('Upload')}</Button>
          <Button size="sm" variant="ghost" className={cn(compact && 'px-2')} aria-label={t('Trash')} title={t('Deleted files')} icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setTrashOpen(true)}>{!compact && t('Trash')}</Button>
        </header>
        {error && <div className="border-b border-border bg-error/8 px-4 py-2 text-[12.5px] text-error">{errorMessage(error)}</div>}
        {!searching && <PasteBar folder={path} />}
        <div
          className={cn('min-h-0 flex-1 overflow-y-auto', dragging && 'bg-accent-soft')}
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          {!searching && path && (
            <button type="button" onClick={() => go({ path: parentOf(path), file: null })}
              className="flex w-full items-center gap-3 border-b border-border px-4 py-2 text-left text-[13px] text-muted hover:bg-surface-hover max-md:py-3.5 max-md:text-[15px]">
              <Folder className="h-4 w-4" /> ..
            </button>
          )}
          {entries.map((e) => (
            <Row key={e.path} entry={e} selected={e.path === openFile} onOpen={() => open(e)} showPath={searching}
              onShowFolder={(p) => { setQuery(''); go({ path: p, file: null }) }} />
          ))}
          {!folder.isPending && entries.length === 0 && (
            <EmptyState
              icon={<Folder className="h-5 w-5" />}
              title={searching ? t('Nothing matches') : t('This folder is empty')}
              description={searching ? undefined : t('Drop files here, or create a file or folder.')}
            />
          )}
        </div>
      </div>
      {selectedEntry && (
        <div className="flex min-w-0 flex-1 flex-col border-l border-border lg:max-w-[55%]">
          <div className="min-h-0 flex-1"><FilePreview entry={selectedEntry} onClose={() => go({ file: null })} /></div>
          <UsedIn path={selectedEntry.path} />
        </div>
      )}
      <TrashDialog open={trashOpen} onOpenChange={setTrashOpen} />
    </div>
  )
}
