/**
 * File manager for the AI workspace: the same folders agents work in.
 * The URL holds the state (?path=folder&file=path) so views can be linked and reloaded.
 */
import { useState, type DragEvent } from 'react'
import { useSearchParams } from 'react-router'
import {
  ChevronRight,
  Download,
  File,
  FilePlus,
  Folder,
  FolderPlus,
  HardDrive,
  Pencil,
  Search,
  Trash2,
  Upload,
  MoveRight,
} from 'lucide-react'
import { errorMessage } from '@/api/client'
import { ActionMenu } from '@/components/ui/ActionMenu'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { cn } from '@/lib/cn'
import {
  downloadUrl,
  type Entry,
  joinPath,
  parentOf,
  useFileSearch,
  useFolder,
  useMakeFolder,
  useMove,
  useSaveFile,
  useTrashPath,
  useUpload,
} from './api'
import { FilePreview } from './components/FilePreview'
import { TrashDialog } from './components/TrashDialog'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function Breadcrumbs({ path, onOpen }: { path: string; onOpen: (path: string) => void }) {
  const parts = path ? path.split('/') : []
  return (
    <div className="flex min-w-0 items-center gap-1 text-[13px]">
      <button type="button" onClick={() => onOpen('')} className="flex items-center gap-1.5 rounded px-1.5 py-1 font-medium hover:bg-surface-hover">
        <HardDrive className="h-4 w-4 text-muted" /> Workspace
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

function Row({ entry, selected, onOpen, showPath }: { entry: Entry; selected: boolean; onOpen: () => void; showPath?: boolean }) {
  const move = useMove()
  const trash = useTrashPath()
  const folder = parentOf(entry.path)

  const rename = () => {
    const name = window.prompt('New name', entry.name)?.trim()
    if (name && name !== entry.name) move.mutate({ source: entry.path, destination: joinPath(folder, name) })
  }
  const moveTo = () => {
    const dest = window.prompt('Move to (path inside the workspace)', entry.path)?.trim().replace(/^\/+/, '')
    if (dest && dest !== entry.path) move.mutate({ source: entry.path, destination: dest })
  }
  const remove = () => {
    if (window.confirm(`Move "${entry.name}" to the trash?`)) trash.mutate(entry.path)
  }
  const error = move.error ?? trash.error

  return (
    <div
      onDoubleClick={onOpen}
      className={cn('group flex items-center gap-3 border-b border-border px-4 py-2 text-[13px] last:border-0 max-md:py-1 max-md:pr-1 max-md:text-[15px]',
        selected ? 'bg-accent-soft' : 'hover:bg-surface-hover')}
    >
      {entry.is_dir ? <Folder className="h-4 w-4 shrink-0 fill-accent/20 text-accent" /> : <File className="h-4 w-4 shrink-0 text-muted" />}
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 truncate py-1.5 text-left">
        {showPath ? entry.path : entry.name}
        {error && <span className="ml-2 text-[12px] text-error">{errorMessage(error)}</span>}
      </button>
      <span className="hidden w-20 text-right text-[12px] text-muted sm:block">{entry.is_dir ? '' : formatSize(entry.size)}</span>
      <span className="hidden w-36 text-right text-[12px] text-muted md:block">{new Date(entry.modified).toLocaleString()}</span>
      {/* Desktop: icons appear on hover (always on touch screens). Phones: a "⋯" menu. */}
      <span className="hidden w-28 justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 pointer-coarse:opacity-100 md:flex">
        {!entry.is_dir && (
          <a href={downloadUrl(entry.path)} download aria-label="Download" className="rounded p-1.5 text-muted hover:text-text">
            <Download className="h-3.5 w-3.5" />
          </a>
        )}
        <button type="button" aria-label="Rename" onClick={rename} className="rounded p-1.5 text-muted hover:text-text"><Pencil className="h-3.5 w-3.5" /></button>
        <button type="button" aria-label="Move" onClick={moveTo} className="rounded p-1.5 text-muted hover:text-text"><MoveRight className="h-3.5 w-3.5" /></button>
        <button type="button" aria-label="Delete" onClick={remove} className="rounded p-1.5 text-muted hover:text-error"><Trash2 className="h-3.5 w-3.5" /></button>
      </span>
      <ActionMenu
        className="md:hidden"
        label={`Actions for ${entry.name}`}
        actions={[
          ...(entry.is_dir ? [] : [{ label: 'Download', icon: <Download />, download: downloadUrl(entry.path) }]),
          { label: 'Rename', icon: <Pencil />, onSelect: rename },
          { label: 'Move', icon: <MoveRight />, onSelect: moveTo },
          { label: 'Move to trash', icon: <Trash2 />, onSelect: remove, danger: true },
        ]}
      />
    </div>
  )
}

export function FilesPage() {
  const [params, setParams] = useSearchParams()
  const path = params.get('path') ?? ''
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

  const newFolder = () => {
    const name = window.prompt('Folder name')?.trim()
    if (name) makeFolder.mutate(joinPath(path, name))
  }
  const newFile = async () => {
    const name = window.prompt('File name', 'untitled.md')?.trim()
    if (!name) return
    const saved = await saveFile.mutateAsync({ path: joinPath(path, name), content: '', base_hash: null })
    go({ file: saved.path })
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

  const searching = query.trim().length > 0
  const entries = searching ? (search.data ?? []) : (folder.data?.entries ?? [])
  const selectedEntry = openFile ? entries.find((e) => e.path === openFile) ?? {
    name: openFile.split('/').pop() ?? openFile, path: openFile, is_dir: false, size: 0, modified: '', mime: null,
  } : null
  const error = folder.error ?? makeFolder.error ?? saveFile.error ?? upload.error

  return (
    <div className="flex h-full">
      <div className={cn('flex min-w-0 flex-1 flex-col', openFile && 'hidden lg:flex')}>
        <header className="flex flex-wrap items-center gap-x-1 gap-y-2 border-b border-border px-3 py-2.5 md:gap-2 md:px-4">
          <div className="w-full min-w-0 md:w-auto md:flex-1"><Breadcrumbs path={path} onOpen={(p) => go({ path: p, file: null })} /></div>
          <div className="relative order-last w-full md:order-none md:w-auto">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find by name"
              className="h-8 w-full rounded-control bg-surface-2 pl-8 pr-2 text-[12.5px] focus:outline-none focus:ring-2 focus:ring-accent-soft pointer-coarse:h-10 md:w-44" />
          </div>
          <Button size="sm" variant="ghost" icon={<FilePlus className="h-3.5 w-3.5" />} onClick={() => void newFile()}>File</Button>
          <Button size="sm" variant="ghost" icon={<FolderPlus className="h-3.5 w-3.5" />} onClick={newFolder}>Folder</Button>
          <Button size="sm" variant="secondary" icon={<Upload className="h-3.5 w-3.5" />} loading={upload.isPending} onClick={pickFiles}>Upload</Button>
          <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setTrashOpen(true)}>Trash</Button>
        </header>
        {error && <div className="border-b border-border bg-error/8 px-4 py-2 text-[12.5px] text-error">{errorMessage(error)}</div>}
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
            <Row key={e.path} entry={e} selected={e.path === openFile} onOpen={() => open(e)} showPath={searching} />
          ))}
          {!folder.isPending && entries.length === 0 && (
            <EmptyState
              icon={<Folder className="h-5 w-5" />}
              title={searching ? 'Nothing matches' : 'This folder is empty'}
              description={searching ? undefined : 'Drop files here, or create a file or folder.'}
            />
          )}
        </div>
      </div>
      {selectedEntry && (
        <div className="flex min-w-0 flex-1 flex-col border-l border-border lg:max-w-[55%]">
          <FilePreview entry={selectedEntry} onClose={() => go({ file: null })} />
        </div>
      )}
      <TrashDialog open={trashOpen} onOpenChange={setTrashOpen} />
    </div>
  )
}
