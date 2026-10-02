import { useState } from 'react'
import { NavLink, useNavigate } from 'react-router'
import { FileText, Folder, Plus, Search } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { promptDialog } from '@/components/ui/dialogs'
import { cn } from '@/lib/cn'
import { formatWhen } from '@/lib/format'
import { type DocumentSummary, useCreateDocument, useDocuments } from '../api'

/**
 * Documents grouped by folder. New documents go into `currentFolder`. With a project
 * chosen (`projectFolder`), only the documents in that project's folder are listed.
 */
export function DocumentList({ currentFolder, projectFolder, projectName }: { currentFolder: string; projectFolder?: string; projectName?: string }) {
  const navigate = useNavigate()
  const documents = useDocuments()
  const create = useCreateDocument()
  const [query, setQuery] = useState('')

  const everything = documents.data?.documents ?? []
  const all = projectFolder
    ? everything.filter((d) => d.folder === projectFolder || d.folder.startsWith(`${projectFolder}/`))
    : everything
  const q = query.trim().toLowerCase()
  const shown = q ? all.filter((d) => d.title.toLowerCase().includes(q) || d.path.toLowerCase().includes(q)) : all
  // Folder name -> its documents; the top level ("") first.
  const groups = new Map<string, DocumentSummary[]>()
  for (const doc of shown) groups.set(doc.folder, [...(groups.get(doc.folder) ?? []), doc])
  const folders = [...groups.keys()].sort((a, b) => a.localeCompare(b))

  const newDocument = async () => {
    const title = await promptDialog({ title: 'New document', label: 'Title', placeholder: 'e.g. Trip to Lisbon', confirmLabel: 'Create' })
    if (!title) return
    create.mutate({ title, folder: currentFolder }, { onSuccess: (doc) => navigate(`/documents/${doc.id}`) })
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold">
          Documents{projectName && <span className="font-normal text-muted"> · {projectName}</span>}
        </h1>
        <Button size="sm" variant="primary" icon={<Plus className="h-4 w-4" />} loading={create.isPending} onClick={() => void newDocument()}>
          New
        </Button>
      </div>
      <div className="relative px-3 py-2">
        <Search className="pointer-events-none absolute left-5.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find by title" aria-label="Find by title"
          className="h-9 w-full rounded-control bg-surface-2 pl-8 pr-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-accent-soft pointer-coarse:h-10" />
      </div>
      {(documents.error ?? create.error) && (
        <p className="px-3 text-[12.5px] text-error">{errorMessage(documents.error ?? create.error)}</p>
      )}
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {documents.isSuccess && all.length === 0 && (
          <p className="px-2 py-6 text-center text-[13px] text-muted">
            {projectFolder
              ? <>No documents in this project yet. They are Markdown files in <code className="font-mono">documents/{projectFolder}</code>.</>
              : <>No documents yet. They are Markdown files in the <code className="font-mono">documents</code> folder of your workspace.</>}
          </p>
        )}
        {documents.isSuccess && all.length > 0 && shown.length === 0 && (
          <p className="px-2 py-6 text-center text-[13px] text-muted">No document matches.</p>
        )}
        {folders.map((folder) => (
          <div key={folder} className="mb-2">
            {folder && (
              <div className="flex items-center gap-1.5 px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-subtle">
                <Folder className="h-3 w-3" /> {folder}
              </div>
            )}
            {groups.get(folder)?.map((doc) => (
              <NavLink key={doc.id} to={`/documents/${doc.id}`}
                className={({ isActive }) =>
                  cn('flex items-start gap-2 rounded-control px-2 py-2 text-[13.5px] transition-colors',
                    isActive ? 'bg-accent-soft text-accent' : 'hover:bg-surface-hover')}>
                <FileText className="mt-0.5 h-4 w-4 shrink-0 opacity-70" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{doc.title}</span>
                  <span className="block truncate text-[11.5px] text-muted">
                    {formatWhen(doc.updated_at)} · {doc.word_count} words
                    {doc.last_editor === 'agent' && ' · by an agent'}
                  </span>
                </span>
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
    </div>
  )
}
