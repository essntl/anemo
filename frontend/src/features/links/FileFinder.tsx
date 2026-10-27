import { useState } from 'react'
import { ChevronLeft, File, FileImage, Folder, Search } from 'lucide-react'
import { formatSize, IMAGE } from './files'
import { type Entry, useFileSearch, useFolder } from '@/features/files/api'
import { cn } from '@/lib/cn'

export function FileIcon({ name, className }: { name: string; className?: string }) {
  return IMAGE.test(name) ? <FileImage className={className} /> : <File className={className} />
}

const parent = (p: string) => p.split('/').slice(0, -1).join('/')

/**
 * Pick a workspace file: type to find one by name, or browse folders (starting in
 * `start`, e.g. the project's folder). Files in documents/ are documents and are
 * picked as documents elsewhere, so they are not offered here.
 */
export function FileFinder({ start = '', onPick }: { start?: string; onPick: (entry: Entry) => void }) {
  const [query, setQuery] = useState('')
  const [folder, setFolder] = useState(start)
  const search = useFileSearch(query.trim())
  const listing = useFolder(folder)
  const searching = query.trim().length > 0
  const entries = (searching ? (search.data ?? []).filter((e) => !e.is_dir) : listing.data?.entries ?? [])
    .filter((e) => e.path !== 'documents' && !e.path.startsWith('documents/'))
  return (
    <div>
      <div className="flex items-center gap-2 rounded-control border border-border bg-surface px-3 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-soft">
        <Search className="h-4 w-4 shrink-0 text-muted" />
        <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a file by name" aria-label="Find a file by name"
          className="h-10 min-w-0 flex-1 bg-transparent text-[14px] placeholder:text-subtle focus:outline-none" />
      </div>
      {!searching && (
        <div className="mt-2 flex items-center gap-1 text-[12.5px] text-muted">
          {folder && (
            <button type="button" onClick={() => setFolder(parent(folder))} aria-label="Up one folder"
              className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-surface-hover pointer-coarse:h-9 pointer-coarse:w-9">
              <ChevronLeft className="h-4 w-4" />
            </button>
          )}
          <span className="truncate font-mono">{folder || 'Workspace'}</span>
        </div>
      )}
      <ul className="mt-1 max-h-72 overflow-y-auto" aria-label={searching ? 'Files found' : `Files in ${folder || 'the workspace'}`}>
        {entries.map((e) => (
          <li key={e.path}>
            <button type="button" onClick={() => (e.is_dir ? setFolder(e.path) : onPick(e))}
              className={cn('flex w-full items-center gap-2.5 rounded-control px-2 py-2 text-left text-[13.5px] hover:bg-surface-hover pointer-coarse:py-3')}>
              {e.is_dir ? <Folder className="h-4 w-4 shrink-0 text-accent" /> : <FileIcon name={e.name} className="h-4 w-4 shrink-0 text-muted" />}
              <span className="min-w-0 flex-1 truncate">{searching ? e.path : e.name}</span>
              {!e.is_dir && <span className="shrink-0 text-[11.5px] text-muted">{formatSize(e.size)}</span>}
            </button>
          </li>
        ))}
        {((searching && search.isSuccess) || (!searching && listing.isSuccess)) && entries.length === 0 && (
          <li className="px-2 py-3 text-[13px] text-muted">{searching ? 'No file matches.' : 'This folder is empty.'}</li>
        )}
      </ul>
    </div>
  )
}
