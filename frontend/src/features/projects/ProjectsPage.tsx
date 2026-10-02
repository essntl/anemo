/**
 * Projects: each one is a workspace of its own for chats, tasks, calendar events,
 * documents and files. Choosing one in the sidebar's switcher narrows every screen to
 * it; "All projects" shows everything together.
 */
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Archive, ArchiveRestore, FolderKanban, Pencil, Plus, Trash2 } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { useProjectStore } from '@/app/projectStore'
import { ActionMenu } from '@/components/ui/ActionMenu'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Dialog } from '@/components/ui/Dialog'
import { confirmDialog } from '@/components/ui/dialogs'
import { EmptyState } from '@/components/ui/EmptyState'
import { Field, Input, Textarea } from '@/components/ui/Input'
import { Lingering } from '@/components/ui/Lingering'
import { Select } from '@/components/ui/Select'
import { useProfiles } from '@/features/profiles/api'
import { useModels } from '@/features/providers/api'
import { type Project, useDeleteProject, useProjects, useSaveProject } from '@/features/tasks/api'

const COLORS = ['#6b7280', '#ef4444', '#f59e0b', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899']

function ProjectDialog({ project, nextColor, onClose }: { project: Project | null; nextColor: string; onClose: () => void }) {
  const save = useSaveProject()
  const models = useModels()
  const profiles = useProfiles()
  const [name, setName] = useState(project?.name ?? '')
  const [color, setColor] = useState(project?.color ?? nextColor)
  const [instructions, setInstructions] = useState(project?.instructions ?? '')
  const [modelId, setModelId] = useState(project?.default_model_id ?? '')
  const [profileId, setProfileId] = useState(project?.default_profile_id ?? '')
  const chatModels = (models.data ?? []).filter((m) => m.enabled && m.provider_enabled && m.capabilities.chat !== false)

  const submit = () =>
    save.mutate(
      {
        id: project?.id, name: name.trim(), color, archived: project?.archived ?? false, instructions,
        default_model_id: modelId || null, default_profile_id: profileId || null,
      },
      { onSuccess: onClose },
    )

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={project ? 'Edit project' : 'New project'}
      description={project
        ? `Files are in ${project.files_path}/ and documents in ${project.documents_path}/. Renaming keeps these folders.`
        : 'A project gets its own folder for files and one for documents.'}
      className="md:w-[min(92vw,520px)]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!name.trim()} onClick={submit}>
            {project ? 'Save' : 'Create project'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name">
          <Input value={name} maxLength={100} autoFocus={!project} placeholder="e.g. Thesis" onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && name.trim() && submit()} />
        </Field>
        <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Colour">
          {COLORS.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} onClick={() => setColor(c)}
              style={{ backgroundColor: c }}
              className={`h-6 w-6 rounded-full pointer-coarse:h-8 pointer-coarse:w-8 ${color === c ? 'ring-2 ring-accent ring-offset-2 ring-offset-card' : ''}`} />
          ))}
        </div>
        <Field label="Instructions for the assistant" hint="Added to every chat in this project, in Chat and Agent mode.">
          <Textarea rows={4} value={instructions} maxLength={20000} placeholder="e.g. This is my thesis on river ecology. Write British English and cite sources."
            onChange={(e) => setInstructions(e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Default model" hint="For new chats here.">
            <Select value={modelId} onValueChange={setModelId}
              options={[{ value: '', label: 'Same as everywhere' }, ...chatModels.map((m) => ({ value: m.id, label: m.display_name }))]} />
          </Field>
          <Field label="Default agent profile" hint="For Agent mode here.">
            <Select value={profileId} onValueChange={setProfileId}
              options={[{ value: '', label: 'Default agent' }, ...(profiles.data ?? []).map((p) => ({ value: p.id, label: p.name }))]} />
          </Field>
        </div>
      </div>
      {save.isError && <p className="mt-3 text-[13px] text-error">{errorMessage(save.error)}</p>}
    </Dialog>
  )
}

function Count({ n, label }: { n: number; label: string }) {
  return <span><span className="font-medium text-text">{n}</span> {label}</span>
}

function ProjectCard({ project, onEdit }: { project: Project; onEdit: () => void }) {
  const navigate = useNavigate()
  const save = useSaveProject()
  const remove = useDeleteProject()
  const { projectId, setProjectId } = useProjectStore()
  const current = projectId === project.id

  const confirmDelete = async () => {
    const ok = await confirmDialog({
      title: `Delete “${project.name}”?`,
      message: `Its chats, tasks and events are kept, without a project. The folders ${project.files_path}/ and ${project.documents_path}/ stay where they are.`,
      confirmLabel: 'Delete project',
      danger: true,
    })
    if (ok) remove.mutate(project.id, { onSuccess: () => current && setProjectId(null) })
  }
  const open = () => {
    setProjectId(project.id)
    void navigate('/')
  }

  return (
    <Card className={project.archived ? 'opacity-70' : undefined}>
      <div className="flex items-start gap-3 px-4 py-3.5 md:px-5">
        <span className="mt-1.5 h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: project.color }} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-[15px] font-semibold">{project.name}</h3>
            {current && <Badge tone="accent">Working in this</Badge>}
            {project.archived && <Badge>Archived</Badge>}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[12.5px] text-muted">
            <Count n={project.chats} label="chats" />
            <Count n={project.open_tasks} label="open tasks" />
            <Count n={project.events} label="events" />
            <Count n={project.documents} label="documents" />
          </div>
          {project.instructions && <p className="mt-1.5 line-clamp-2 text-[12.5px] text-subtle">{project.instructions}</p>}
          {(save.error ?? remove.error) && <p className="mt-1 text-[12px] text-error">{errorMessage(save.error ?? remove.error)}</p>}
        </div>
        {!project.archived && !current && <Button size="sm" variant="secondary" onClick={open}>Open</Button>}
        <ActionMenu
          label={`Actions for ${project.name}`}
          actions={[
            { label: 'Edit', icon: <Pencil />, onSelect: onEdit },
            project.archived
              ? { label: 'Use again', icon: <ArchiveRestore />, onSelect: () => save.mutate({ ...project, archived: false }) }
              : { label: 'Archive', icon: <Archive />, onSelect: () => save.mutate({ ...project, archived: true }, { onSuccess: () => current && setProjectId(null) }) },
            { label: 'Delete', icon: <Trash2 />, danger: true, onSelect: () => void confirmDelete() },
          ]}
        />
      </div>
    </Card>
  )
}

export function ProjectsPage() {
  const projects = useProjects()
  const [editing, setEditing] = useState<{ project: Project | null } | null>(null)
  const all = projects.data ?? []
  return (
    <div className="mx-auto max-w-3xl p-4 md:p-8">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <FolderKanban className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold">Projects</h1>
          <p className="text-[13px] text-muted">Each project has its own chats, tasks, calendar, documents and files.</p>
        </div>
        <Button size="sm" variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({ project: null })}>
          New project
        </Button>
      </div>
      {projects.error && <p className="mb-2 text-[13px] text-error">{errorMessage(projects.error)}</p>}
      {projects.isSuccess && all.length === 0 ? (
        <EmptyState icon={<FolderKanban className="h-5 w-5" />} title="No projects yet"
          description="Create one to keep the chats, tasks, events, documents and files of one piece of work together." />
      ) : (
        <div className="flex flex-col gap-3">
          {all.map((p) => <ProjectCard key={p.id} project={p} onEdit={() => setEditing({ project: p })} />)}
        </div>
      )}
      <Lingering value={editing}>
        {(shown) => (
          <ProjectDialog project={shown.project} nextColor={COLORS[all.length % COLORS.length]} onClose={() => setEditing(null)} />
        )}
      </Lingering>
    </div>
  )
}
