import { useState } from 'react'
import { useNavigate } from 'react-router'
import { CornerDownRight, Timer, Trash2, X } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { confirmDialog, promptDialog } from '@/components/ui/dialogs'
import { Field, Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { cn } from '@/lib/cn'
import { RichEditor } from '@/features/documents/components/RichEditor'
import { tidyMarkdown } from '@/features/documents/markdown'
import { focusOnTask } from '@/features/focus/focusOnTask'
import { BacklinkList } from '@/features/links/BacklinkList'
import { TaskAttachments } from '@/features/links/TaskAttachments'
import { useTaskBacklinks } from '@/features/links/api'
import {
  PRIORITY_LABELS,
  STATUS_LABELS,
  type Task,
  type TaskStatus,
  useCreateTask,
  useDeleteTask,
  useProjects,
  useSaveProject,
  useTasks,
  useUpdateTask,
} from '../api'
import { REMINDER_OPTIONS } from '../dates'
import { askAboutSubtasks, openSubtasksLeft, parentCandidates } from '../relations'
import { repeatOptions } from '../repeat'
import { BlockedByEditor, ChecklistEditor, SubtaskList } from './TaskStructure'

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
  /** Open another task in the editor instead (a subtask, its parent, one it waits on). */
  onOpenTask?: (task: Task) => void
  /**
   * Shown as a panel beside the task list (very wide screens) instead of over it: the
   * same editor in one column, and the list stays in reach.
   */
  panel?: boolean
}

const tagList = (text: string) => text.split(',').map((t) => t.trim()).filter(Boolean)

export function TaskDialog({ task, defaults, onClose, onOpenTask, panel }: TaskDialogProps) {
  const projects = useProjects()
  const all = useTasks().data ?? []
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
  const [repeat, setRepeat] = useState(task?.rrule ?? '')
  const [projectId, setProjectId] = useState(task?.project_id ?? defaults?.project_id ?? '')
  const [tags, setTags] = useState((task?.tags ?? []).join(', '))
  const [checklist, setChecklist] = useState(task?.checklist ?? [])
  const [parentId, setParentId] = useState(task?.parent_id ?? '')
  const [blockedBy, setBlockedBy] = useState(task?.blocked_by ?? [])
  const parents = parentCandidates(all, task)
  const parent = all.find((t) => t.id === parentId)
  const hasSubtasks = task !== null && all.some((t) => t.parent_id === task.id)
  const backlinks = useTaskBacklinks(task?.id ?? null)
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
  const save = async (after: () => void = onClose) => {
    // Finished here with open subtasks: finish them too, or keep them open?
    const finishing = task !== null && status === 'done' && task.status !== 'done'
    const choice = await askAboutSubtasks(finishing ? openSubtasksLeft(all, [task.id]) : 0)
    if (choice === null) return
    const body = {
      title: title.trim(),
      description,
      status,
      priority: Number(priority),
      due_date: dueDate || null,
      due_time: dueDate && dueTime ? `${dueTime}:00` : null,
      remind_minutes: dueDate && remind !== '' ? Number(remind) : null,
      rrule: dueDate && repeat ? repeat : null,
      project_id: projectId || null,
      tags: tagList(tags),
      checklist: checklist.filter((i) => i.text.trim()),
      parent_id: parentId || null,
      blocked_by: blockedBy,
    }
    if (task) update.mutate({ id: task.id, body: { ...body, ...(choice ? { subtasks: choice } : {}) } }, { onSuccess: after })
    else create.mutate(body, { onSuccess: after })
  }
  // Another task opens in the editor: keep what was typed here first, like Save would.
  const openTask = onOpenTask
    ? (other: Task) => {
        if (title.trim()) void save(() => onOpenTask(other))
        else onOpenTask(other)
      }
    : undefined
  // A link in the notes leads away from the editor: keep what was typed, like Save would.
  const openLink = (path: string) => {
    const leave = () => {
      onClose()
      void navigate(path)
    }
    if (title.trim()) void save(leave)
    else leave()
  }
  const confirmDelete = async () => {
    if (!task) return
    const ok = await confirmDialog({ title: 'Delete this task?', message: task.title, confirmLabel: 'Delete', danger: true })
    if (ok) remove.mutate(task.id, { onSuccess: onClose })
  }

  const wide = !panel
  const body = (
    // Laid out like a document: the title, status and notes take most of the window; what
    // files the task (schedule, project, priority, tags) and the buttons are in a panel
    // at the side. On a phone the panel comes below the notes and the buttons stay in view.
    // Beside the panel the notes are exactly as tall as it is (the left column takes no
    // height of its own), and longer notes scroll inside their box.
      <div className={cn('flex flex-col gap-5', wide && 'md:grid md:min-h-[min(68dvh,44rem)] md:grid-cols-[minmax(0,1fr)_18rem] md:gap-6')}>
        <div className="relative min-w-0">
        <div className={cn('flex flex-col gap-3', wide && 'md:absolute md:inset-0')}>
          <input aria-label="Title" autoFocus={!task} value={title} maxLength={300} placeholder="What needs doing?"
            onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && title.trim() && void save()}
            className="w-full bg-transparent text-xl font-semibold placeholder:font-medium placeholder:text-subtle focus:outline-none md:text-2xl" />
          {/* The status and the notes box are moved out by their own padding, so their text
              starts on the same line as the heading and the title above them. */}
          <div className="flex flex-wrap items-center gap-2 md:-ml-3">
            <Select variant="pill" aria-label="Status" value={status} onValueChange={(v) => setStatus(v as TaskStatus)}
              options={Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }))} />
            {parent && (
              <button type="button" disabled={!openTask} onClick={() => openTask?.(parent)} title={`Subtask of “${parent.title}”`}
                className="flex min-w-0 items-center gap-1 text-[12.5px] text-muted enabled:hover:text-accent">
                <CornerDownRight className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">Subtask of {parent.title}</span>
              </button>
            )}
            {task?.created_by === 'agent' && <span className="text-[12px] text-muted">Added by an agent.</span>}
          </div>
          <div className="md:-ml-1"><ChecklistEditor items={checklist} onChange={setChecklist} /></div>
          {/* Stored as Markdown, like documents. An empty editor gives an empty text. */}
          <RichEditor variant="notes" className="md:-ml-3 md:flex-1" label="Notes" initial={task?.description ?? ''} onOpenAppLink={openLink}
            onChange={(markdown) => setDescription(markdown.trim() ? tidyMarkdown(markdown) : '')} />
        </div>
        </div>

        <aside aria-label="Details" className={cn('flex flex-col gap-4', wide && 'md:border-l md:border-border md:pl-6')}>
          <Field label="Due date">
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
          <Field label="Time (optional)">
            <Input type="time" value={dueTime} disabled={!dueDate} onChange={(e) => setDueTime(e.target.value)} />
          </Field>
          <Field label="Reminder" hint={dueDate && !dueTime ? 'Counted from 09:00 on the due day' : undefined}>
            <Select value={remind} onValueChange={setRemind} disabled={!dueDate} options={reminderOptions(remind)} />
          </Field>
          <Field label="Repeat" hint={repeat && dueDate ? 'Finishing it adds the next one' : undefined}>
            <Select value={dueDate ? repeat : ''} onValueChange={setRepeat} disabled={!dueDate} options={repeatOptions(repeat)} />
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
          <Field label="Subtask of" hint={hasSubtasks ? 'It has subtasks of its own, so it can’t be one.' : undefined}>
            <Select value={parentId} onValueChange={setParentId} disabled={hasSubtasks} aria-label="Subtask of"
              options={[
                { value: '', label: 'Not a subtask' },
                // The current parent stays listed even when it is finished.
                ...[...(parent && !parents.includes(parent) ? [parent] : []), ...parents].map((p) => ({ value: p.id, label: p.title })),
              ]} />
          </Field>
          {!parentId && (
            <SubtaskList task={task} all={all} projectId={projectId || null} tags={tagList(tags)} onOpen={openTask} />
          )}
          <BlockedByEditor task={task} all={all} blockedBy={blockedBy} onChange={setBlockedBy} onOpen={openTask} />
          <TaskAttachments taskId={task?.id ?? null} projectId={projectId || null} />
          <BacklinkList title="Linked from" links={backlinks.data} />
          {task && status !== 'done' && status !== 'cancelled' && (
            <Button variant="secondary" icon={<Timer className="h-4 w-4" />} onClick={() => focusOnTask(task)}>
              Focus on this
            </Button>
          )}
          {error && <p className="text-[12.5px] text-error">{errorMessage(error)}</p>}

          {/* Phone: a bar that stays at the bottom of the sheet (which has no padding of its
              own there, so nothing shows under the bar). Desktop: the foot of the panel. */}
          <div className={cn('sticky bottom-0 -mx-5 mt-auto flex items-center justify-end gap-2 border-t border-border bg-card px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3', wide && 'md:static md:mx-0 md:border-0 md:p-0 md:pt-2')}>
            {task && (
              <Button variant="ghost" className="mr-auto" icon={<Trash2 className="h-4 w-4" />} loading={remove.isPending}
                onClick={() => void confirmDelete()}>
                Delete
              </Button>
            )}
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={pending} disabled={!title.trim()} onClick={() => void save()}>
              {task ? 'Save' : 'Add task'}
            </Button>
          </div>
        </aside>
      </div>
  )
  if (panel) {
    return (
      // Not modal: the list beside it stays in use. Esc closes it, as it closes the dialog.
      <aside role="dialog" aria-label={task ? 'Task' : 'New task'}
        onKeyDown={(e) => e.key === 'Escape' && !e.defaultPrevented && onClose()}
        className="flex h-full w-[27rem] shrink-0 flex-col overflow-y-auto rounded-panel border border-border bg-card px-5 pt-4 shadow-soft">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">{task ? 'Task' : 'New task'}</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-muted hover:bg-surface-hover hover:text-text">
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </button>
        </div>
        {body}
      </aside>
    )
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} className="max-md:pb-0 md:w-[min(96vw,1020px)]" title={task ? 'Task' : 'New task'}>
      {body}
    </Dialog>
  )
}
