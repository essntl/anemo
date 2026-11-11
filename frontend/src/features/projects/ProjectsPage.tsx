/**
 * Projects: each one is a workspace of its own for chats, tasks, calendar events,
 * documents and files. Choosing one in the sidebar's switcher narrows every screen to
 * it; "All projects" shows everything together.
 */
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Archive, ArchiveRestore, FolderKanban, Link2, Pencil, Plus, Trash2 } from 'lucide-react'
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
import { useShareDialog } from '@/features/shares/shareStore'
import { type Project, useDeleteProject, useProjects, useSaveProject } from '@/features/tasks/api'
import { PageHeader } from '@/components/ui/PageHeader'
import { plural, t } from '@/lib/i18n'

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
      title={project ? t('Edit project') : t('New project')}
      description={project
        ? t('Files are in {files}/ and documents in {documents}/. Renaming keeps these folders.', { files: project.files_path, documents: project.documents_path })
        : t('A project gets its own folder for files and one for documents.')}
      className="md:w-[min(92vw,520px)]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={!name.trim()} onClick={submit}>
            {project ? t('Save') : t('Create project')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={t('Name')}>
          <Input value={name} maxLength={100} autoFocus={!project} placeholder={t('e.g. Thesis')} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && name.trim() && submit()} />
        </Field>
        <div className="flex items-center gap-1.5" role="radiogroup" aria-label={t('Colour')}>
          {COLORS.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} onClick={() => setColor(c)}
              style={{ backgroundColor: c }}
              className={`h-6 w-6 rounded-full pointer-coarse:h-8 pointer-coarse:w-8 ${color === c ? 'ring-2 ring-accent ring-offset-2 ring-offset-card' : ''}`} />
          ))}
        </div>
        <Field label={t('Instructions for the assistant')} hint={t('Added to every chat in this project, in Chat and Agent mode.')}>
          <Textarea rows={4} value={instructions} maxLength={20000} placeholder={t('e.g. This is my thesis on river ecology. Write British English and cite sources.')}
            onChange={(e) => setInstructions(e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('Default model')} hint={t('For new chats here.')}>
            <Select value={modelId} onValueChange={setModelId}
              options={[{ value: '', label: t('Same as everywhere') }, ...chatModels.map((m) => ({ value: m.id, label: m.display_name }))]} />
          </Field>
          <Field label={t('Default agent profile')} hint={t('For Agent mode here.')}>
            <Select value={profileId} onValueChange={setProfileId}
              options={[{ value: '', label: t('Default agent') }, ...(profiles.data ?? []).map((p) => ({ value: p.id, label: p.name }))]} />
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
  const askShare = useShareDialog((s) => s.ask)
  const current = projectId === project.id

  const confirmDelete = async () => {
    const ok = await confirmDialog({
      title: t('Delete “{name}”?', { name: project.name }),
      message: t('Its chats, tasks and events are kept, without a project. The folders {files}/ and {documents}/ stay where they are.', { files: project.files_path, documents: project.documents_path }),
      confirmLabel: t('Delete project'),
      danger: true,
    })
    // mutateAsync: this card is gone before the answer arrives.
    if (ok) void remove.mutateAsync(project.id).then(() => current && setProjectId(null), () => undefined)
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
            {current && <Badge tone="accent">{t('Working in this')}</Badge>}
            {project.archived && <Badge>{t('Archived')}</Badge>}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[12.5px] text-muted">
            <Count n={project.chats} label={plural(project.chats, 'chats', 'chats')} />
            <Count n={project.open_tasks} label={plural(project.open_tasks, 'open tasks', 'open tasks')} />
            <Count n={project.events} label={plural(project.events, 'events', 'events')} />
            <Count n={project.documents} label={plural(project.documents, 'documents', 'documents')} />
          </div>
          {project.instructions && <p className="mt-1.5 line-clamp-2 text-[12.5px] text-subtle">{project.instructions}</p>}
          {(save.error ?? remove.error) && <p className="mt-1 text-[12px] text-error">{errorMessage(save.error ?? remove.error)}</p>}
        </div>
        {!project.archived && !current && <Button size="sm" variant="secondary" onClick={open}>{t('Open')}</Button>}
        <ActionMenu
          label={t('Actions for {name}', { name: project.name })}
          actions={[
            { label: t('Edit'), icon: <Pencil />, onSelect: onEdit },
            { label: t('Share'), icon: <Link2 />, onSelect: () => askShare({ kind: 'project', id: project.id, title: project.name }) },
            project.archived
              ? { label: t('Use again'), icon: <ArchiveRestore />, onSelect: () => save.mutate({ ...project, archived: false }) }
              : { label: t('Archive'), icon: <Archive />, onSelect: () => save.mutate({ ...project, archived: true }, { onSuccess: () => current && setProjectId(null) }) },
            { label: t('Delete'), icon: <Trash2 />, danger: true, onSelect: () => void confirmDelete() },
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
    <div className="mx-auto max-w-3xl p-4 md:px-8 md:pb-8 md:pt-2">
      <PageHeader title={t('Projects')}>
        <Button size="sm" variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({ project: null })}>
          {t('New project')}
        </Button>
      </PageHeader>
      <p className="mb-4 max-w-2xl text-[13px] text-muted">{t('Each project has its own chats, tasks, calendar, documents and files.')}</p>
      {projects.error && <p className="mb-2 text-[13px] text-error">{errorMessage(projects.error)}</p>}
      {projects.isSuccess && all.length === 0 ? (
        <EmptyState icon={<FolderKanban className="h-5 w-5" />} title={t('No projects yet')}
          description={t('Create one to keep the chats, tasks, events, documents and files of one piece of work together.')} />
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
