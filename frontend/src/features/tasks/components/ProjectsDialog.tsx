import { useState } from 'react'
import { Archive, ArchiveRestore, Plus, Trash2 } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { confirmDialog } from '@/components/ui/dialogs'
import { Input } from '@/components/ui/Input'
import { type Project, useDeleteProject, useProjects, useSaveProject } from '../api'

const COLORS = ['#6b7280', '#ef4444', '#f59e0b', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899']

function ProjectRow({ project }: { project: Project }) {
  const save = useSaveProject()
  const remove = useDeleteProject()
  const [name, setName] = useState(project.name)
  const change = (patch: Partial<Project>) => save.mutate({ ...project, ...patch })
  const rename = () => name.trim() && name.trim() !== project.name && change({ name: name.trim() })

  const confirmDelete = async () => {
    const ok = await confirmDialog({
      title: `Delete “${project.name}”?`,
      message: 'Its tasks are kept, without a project.',
      confirmLabel: 'Delete',
      danger: true,
    })
    if (ok) remove.mutate(project.id)
  }

  return (
    <div className="flex flex-col gap-1.5 py-2">
      <div className="flex items-center gap-2">
        <Input value={name} maxLength={100} aria-label="Project name" onChange={(e) => setName(e.target.value)}
          onBlur={rename} onKeyDown={(e) => e.key === 'Enter' && rename()}
          className={project.archived ? 'h-9 opacity-60' : 'h-9'} />
        <Button size="icon" variant="ghost" aria-label={project.archived ? 'Use again' : 'Archive'}
          title={project.archived ? 'Use again' : 'Archive: hide from the project lists'}
          onClick={() => change({ archived: !project.archived })}>
          {project.archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
        </Button>
        <Button size="icon" variant="ghost" aria-label="Delete project" onClick={() => void confirmDelete()}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Colour">
        {COLORS.map((color) => (
          <button key={color} type="button" role="radio" aria-checked={project.color === color} aria-label={color}
            onClick={() => change({ color })} style={{ backgroundColor: color }}
            className={`h-5 w-5 rounded-full pointer-coarse:h-7 pointer-coarse:w-7 ${project.color === color ? 'ring-2 ring-accent ring-offset-2 ring-offset-card' : ''}`} />
        ))}
        <span className="ml-auto text-[12px] text-muted">{project.open_tasks} open</span>
      </div>
      {(save.error ?? remove.error) && <p className="text-[12px] text-error">{errorMessage(save.error ?? remove.error)}</p>}
    </div>
  )
}

/** Rename, colour, archive and delete projects, and add new ones. */
export function ProjectsDialog({ onClose }: { onClose: () => void }) {
  const projects = useProjects()
  const create = useSaveProject()
  const [name, setName] = useState('')
  const add = () => {
    if (!name.trim()) return
    create.mutate({ name: name.trim(), color: COLORS[(projects.data?.length ?? 0) % COLORS.length] }, { onSuccess: () => setName('') })
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title="Projects" description="Groups for your tasks.">
      <div className="flex gap-2">
        <Input value={name} placeholder="New project" maxLength={100} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()} />
        <Button variant="primary" icon={<Plus className="h-4 w-4" />} loading={create.isPending} disabled={!name.trim()} onClick={add}>
          Add
        </Button>
      </div>
      {create.isError && <p className="mt-1 text-[12px] text-error">{errorMessage(create.error)}</p>}
      <div className="mt-3 flex flex-col divide-y divide-border">
        {projects.data?.map((p) => <ProjectRow key={p.id} project={p} />)}
        {projects.data?.length === 0 && <p className="py-3 text-[13px] text-muted">No projects yet.</p>}
      </div>
    </Dialog>
  )
}
