import { Link, useNavigate } from 'react-router'
import { FileText, Plus } from 'lucide-react'
import { useMemo } from 'react'
import { useScope } from '@/app/projectStore'
import { useProjects } from '@/features/tasks/api'
import { useCreateDocument } from '@/features/documents/api'
import { useRecentDocuments } from '../api'
import type { WidgetLayout } from '../layout'
import { ROWS } from './rows'
import { WidgetHeader } from './parts'

/** Recent documents: the last edited ones with their first line; + starts a new one. */
export function DocumentsWidget({ item }: { item: WidgetLayout }) {
  const navigate = useNavigate()
  const scope = useScope()
  const project = scope.kind === 'project' ? scope.project : null
  const projects = useProjects()
  const rows = ROWS[item.h] + (item.w > 1 ? 2 : 0)
  // Uncategorized: the server can't leave the projects' folders out, so more are asked
  // for and those in a project's folder are dropped here.
  const unfiled = scope.kind === 'uncategorized'
  const docs = useRecentDocuments(unfiled ? rows + 30 : rows, project?.slug)
  const shown = useMemo(() => {
    const all = docs.data ?? []
    if (!unfiled) return all
    const folders = (projects.data ?? []).map((p) => p.slug)
    return all.filter((d) => !folders.some((f) => d.folder === f || d.folder.startsWith(`${f}/`))).slice(0, rows)
  }, [docs.data, projects.data, unfiled, rows])
  const create = useCreateDocument()
  return (
    <>
      <WidgetHeader title="Recent documents" icon={<FileText />} to="/documents">
        <button type="button" aria-label="New document" title="New document" disabled={create.isPending}
          onClick={() => create.mutate({ title: 'Untitled', folder: project?.slug ?? '' }, { onSuccess: (doc) => void navigate(`/documents/${doc.id}`) })}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-hover hover:text-text pointer-coarse:h-10 pointer-coarse:w-10">
          <Plus className="h-4 w-4" />
        </button>
      </WidgetHeader>
      <div className="flex-1 px-2 pb-3">
        {docs.isSuccess && shown.length === 0 && <p className="px-2 py-2 text-[13px] text-muted">No documents yet.</p>}
        <ul>
          {shown.map((d) => (
            <li key={d.id}>
              <Link to={`/documents/${d.id}`} className="block rounded-control px-2 py-1.5 hover:bg-surface-hover">
                <span className="block truncate text-[13.5px] font-medium">{d.title}</span>
                <span className="block truncate text-[12px] text-muted">{d.excerpt || 'Empty'}</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}
