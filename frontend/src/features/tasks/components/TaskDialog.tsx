import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { confirmDialog, promptDialog } from '@/components/ui/dialogs'
import { Field, Input, Textarea } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
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

  const save = () => {
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
    if (task) update.mutate({ id: task.id, body }, { onSuccess: onClose })
    else create.mutate(body, { onSuccess: onClose })
  }
  const confirmDelete = async () => {
    if (!task) return
    const ok = await confirmDialog({ title: 'Delete this task?', message: task.title, confirmLabel: 'Delete', danger: true })
    if (ok) remove.mutate(task.id, { onSuccess: onClose })
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} className="md:w-[min(94vw,560px)]"
      title={task ? 'Task' : 'New task'}
      footer={
        <>
          {task && (
            <Button variant="ghost" className="mr-auto" icon={<Trash2 className="h-4 w-4" />} loading={remove.isPending}
              onClick={() => void confirmDelete()}>
              Delete
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={pending} disabled={!title.trim()} onClick={save}>
            {task ? 'Save' : 'Add task'}
          </Button>
        </>
      }>
      <div className="flex flex-col gap-4">
        <Field label="Title">
          <Input autoFocus={!task} value={title} maxLength={300} placeholder="What needs doing?"
            onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && title.trim() && save()} />
        </Field>
        <Field label="Notes">
          <Textarea rows={3} value={description} maxLength={20_000} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Status">
            <Select value={status} onValueChange={(v) => setStatus(v as TaskStatus)}
              options={Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }))} />
          </Field>
          <Field label="Priority">
            <Select value={priority} onValueChange={setPriority}
              options={PRIORITY_LABELS.map((label, i) => ({ value: String(i), label }))} />
          </Field>
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
        </div>
        <Field label="Tags" hint="Comma-separated">
          <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="errands, phone" />
        </Field>
        {task?.created_by === 'agent' && <p className="text-[12px] text-muted">Added by an agent.</p>}
        {error && <p className="text-[12.5px] text-error">{errorMessage(error)}</p>}
      </div>
    </Dialog>
  )
}
