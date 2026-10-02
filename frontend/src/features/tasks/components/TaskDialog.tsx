import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Trash2 } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { confirmDialog, promptDialog } from '@/components/ui/dialogs'
import { Field, Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { RichEditor } from '@/features/documents/components/RichEditor'
import { tidyMarkdown } from '@/features/documents/markdown'
import {
  PRIORITY_LABELS,
  STATUS_LABELS,
  type Task,
  type TaskStatus,
  useCreateTask,
  useDeleteTask,
  useProjects,
  useSaveProject,
  useUpdateTask,
} from '../api'
import { REMINDER_OPTIONS } from '../dates'

const NEW_PROJECT = '__new__'

/** Reminder choices plus the current value when it is not one of them (set by an agent). */
function reminderOptions(current: string) {
  if (REMINDER_OPTIONS.some((o) => o.value === current)) return REMINDER_OPTIONS
  return [...REMINDER_OPTIONS, { value: current, label: `${current} minutes before` }]
}

interface TaskDialogProps {
  /** null: a new task. */
  task: Task | null
  /** Starting values for a new task (e.g. the day clicked in the calendar). */
  defaults?: { due_date?: string; project_id?: string | null; status?: TaskStatus }
  onClose: () => void
}

export function TaskDialog({ task, defaults, onClose }: TaskDialogProps) {
  const projects = useProjects()
  const create = useCreateTask()
  const update = useUpdateTask()
  const remove = useDeleteTask()
  const saveProject = useSaveProject()
  const navigate = useNavigate()
  const [title, setTitle] = useState(task?.title ?? '')
  const [description, setDescription] = useState(task?.description ?? '')
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? defaults?.status ?? 'todo')
  const [priority, setPriority] = useState(String(task?.priority ?? 0))
  const [dueDate, setDueDate] = useState(task?.due_date ?? defaults?.due_date ?? '')
  const [dueTime, setDueTime] = useState(task?.due_time?.slice(0, 5) ?? '')
  const [remind, setRemind] = useState(task?.remind_minutes != null ? String(task.remind_minutes) : '')
  const [projectId, setProjectId] = useState(task?.project_id ?? defaults?.project_id ?? '')
  const [tags, setTags] = useState((task?.tags ?? []).join(', '))
  const pending = create.isPending || update.isPending
  const error = create.error ?? update.error ?? remove.error ?? saveProject.error

  const chooseProject = async (value: string) => {
    if (value !== NEW_PROJECT) return setProjectId(value)
    const name = await promptDialog({ title: 'New project', label: 'Name', confirmLabel: 'Create' })
    if (!name) return
    const project = await saveProject.mutateAsync({ name, color: '#6b7280' }).catch(() => null)
    if (project) setProjectId(project.id)
  }

  /** Saves the task, then closes the dialog (or does `after` instead). */
  const save = (after: () => void = onClose) => {
    const body = {
      title: title.trim(),
      description,
      status,
      priority: Number(priority),
      due_date: dueDate || null,
      due_time: dueDate && dueTime ? `${dueTime}:00` : null,
      remind_minutes: dueDate && remind !== '' ? Number(remind) : null,
      project_id: projectId || null,
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
    }
    if (task) update.mutate({ id: task.id, body }, { onSuccess: after })
    else create.mutate(body, { onSuccess: after })
  }
  // A link in the notes leads away from the editor: keep what was typed, like Save would.
  const openLink = (path: string) => {
    const leave = () => {
      onClose()
      void navigate(path)
    }
    if (title.trim()) save(leave)
    else leave()
  }
  const confirmDelete = async () => {
    if (!task) return
    const ok = await confirmDialog({ title: 'Delete this task?', message: task.title, confirmLabel: 'Delete', danger: true })
    if (ok) remove.mutate(task.id, { onSuccess: onClose })
  }

  return (
    // Laid out like a document: the title, status and notes take most of the window; what
    // files the task (schedule, project, priority, tags) and the buttons are in a panel
    // at the side. On a phone the panel comes below the notes and the buttons stay in view.
    <Dialog open onOpenChange={(open) => !open && onClose()} className="max-md:pb-0 md:w-[min(96vw,1020px)]" title={task ? 'Task' : 'New task'}>
      <div className="flex flex-col gap-5 md:grid md:grid-cols-[minmax(0,1fr)_18rem] md:gap-6">
        <div className="flex min-w-0 flex-col gap-3">
          <input aria-label="Title" autoFocus={!task} value={title} maxLength={300} placeholder="What needs doing?"
            onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && title.trim() && save()}
            className="w-full bg-transparent text-xl font-semibold placeholder:font-medium placeholder:text-subtle focus:outline-none md:text-2xl" />
          <div className="flex flex-wrap items-center gap-2">
            <Select variant="pill" aria-label="Status" value={status} onValueChange={(v) => setStatus(v as TaskStatus)}
              options={Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }))} />
            {task?.created_by === 'agent' && <span className="text-[12px] text-muted">Added by an agent.</span>}
          </div>
          {/* Stored as Markdown, like documents. An empty editor gives an empty text. */}
          <RichEditor variant="notes" label="Notes" initial={task?.description ?? ''} onOpenAppLink={openLink}
            onChange={(markdown) => setDescription(markdown.trim() ? tidyMarkdown(markdown) : '')} />
        </div>

        <aside aria-label="Details" className="flex flex-col gap-4 md:border-l md:border-border md:pl-6">
          <Field label="Due date">
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
          <Field label="Time (optional)">
            <Input type="time" value={dueTime} disabled={!dueDate} onChange={(e) => setDueTime(e.target.value)} />
          </Field>
          <Field label="Reminder" hint={dueDate && !dueTime ? 'Counted from 09:00 on the due day' : undefined}>
            <Select value={remind} onValueChange={setRemind} disabled={!dueDate} options={reminderOptions(remind)} />
          </Field>
          <Field label="Project">
            <Select value={projectId} onValueChange={(v) => void chooseProject(v)}
              options={[
                { value: '', label: 'No project' },
                ...(projects.data ?? []).filter((p) => !p.archived || p.id === projectId).map((p) => ({ value: p.id, label: p.name })),
                { value: NEW_PROJECT, label: 'New project…' },
              ]} />
          </Field>
          <Field label="Priority">
            <Select value={priority} onValueChange={setPriority}
              options={PRIORITY_LABELS.map((label, i) => ({ value: String(i), label }))} />
          </Field>
          <Field label="Tags" hint="Comma-separated">
            <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="errands, phone" />
          </Field>
          {error && <p className="text-[12.5px] text-error">{errorMessage(error)}</p>}

          {/* Phone: a bar that stays at the bottom of the sheet (which has no padding of its
              own there, so nothing shows under the bar). Desktop: the foot of the panel. */}
          <div className="sticky bottom-0 -mx-5 mt-auto flex items-center justify-end gap-2 border-t border-border bg-card px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 md:static md:mx-0 md:border-0 md:p-0 md:pt-2">
            {task && (
              <Button variant="ghost" className="mr-auto" icon={<Trash2 className="h-4 w-4" />} loading={remove.isPending}
                onClick={() => void confirmDelete()}>
                Delete
              </Button>
            )}
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={pending} disabled={!title.trim()} onClick={() => save()}>
              {task ? 'Save' : 'Add task'}
            </Button>
          </div>
        </aside>
      </div>
    </Dialog>
  )
}
