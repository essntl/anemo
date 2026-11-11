import { useEffect, useRef, useState } from 'react'
import {
  Bell, CalendarDays, Check, ChevronRight, CornerDownRight, Flag, ListChecks, ListTree, Lock, PanelRightOpen, Repeat,
  Timer, Trash2,
} from 'lucide-react'
import { ActionMenu } from '@/components/ui/ActionMenu'
import { Markdown } from '@/components/ui/Markdown'
import { toast } from '@/components/ui/toast'
import { focusOnTask } from '@/features/focus/focusOnTask'
import { cn } from '@/lib/cn'
import { plural, t } from '@/lib/i18n'
import { PRIORITY_LABELS, type Project, type Task, useCreateTask, useDeleteTask } from '../api'
import { bucketOf, formatDue } from '../dates'
import { checklistProgress, isOpen, openBlockers, subtasksOf } from '../relations'
import { describeRepeat } from '../repeat'
import { useToggleDone } from '../useToggleDone'

const PRIORITY_TONE = ['', 'text-muted', 'text-warning', 'text-error']

/** Every task, to show how a task relates to others (its subtasks, what it waits on). */
export interface TaskInfo {
  all: Task[]
  byId: Map<string, Task>
}

/** "Waits on: Paint the walls, Buy tiles" (only those still open), or null. */
export function BlockedBadge({ task, info }: { task: Task; info: TaskInfo }) {
  const blockers = openBlockers(task, info.byId)
  if (!isOpen(task) || blockers.length === 0) return null
  const names = blockers.map((t) => t.title).join(', ')
  return (
    <span title={t('Waits on: {names}', { names })} aria-label={blockers.length === 1 ? t('Waits on {names}', { names }) : plural(blockers.length, 'Waits on {n} task', 'Waits on {n} tasks')}
      className="flex shrink-0 items-center gap-1 rounded-full bg-warning/12 px-2 py-0.5 text-[11px] text-warning">
      <Lock className="h-3 w-3" /> {t('Waits on {n}', { n: blockers.length })}
    </span>
  )
}

/**
 * The small facts under a task's title: due date, priority, project, tags, and with
 * `info` its checklist and subtask progress, and the task it is a subtask of (unless
 * `nested`: then it is shown right under that task).
 */
export function TaskMeta({ task, project, info, nested = false }: { task: Task; project?: Project; info?: TaskInfo; nested?: boolean }) {
  const open = isOpen(task)
  const overdue = open && bucketOf(task) === 'overdue'
  const checklist = checklistProgress(task.checklist)
  const subtasks = info ? subtasksOf(info.all, task.id) : []
  const parent = info && task.parent_id && !nested ? info.byId.get(task.parent_id) : undefined
  return (
    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[12px] text-muted">
      {task.due_date && (
        <span className={cn('flex items-center gap-1', overdue && 'font-medium text-error')}>
          <CalendarDays className="h-3 w-3" /> {formatDue(task)}
          {task.remind_minutes != null && <Bell className="h-3 w-3" aria-label={t('Has a reminder')} />}
          {task.rrule && <Repeat className="h-3 w-3" aria-label={describeRepeat(task.rrule)}><title>{describeRepeat(task.rrule)}</title></Repeat>}
        </span>
      )}
      {task.priority > 0 && (
        <span className={cn('flex items-center gap-1', PRIORITY_TONE[task.priority])}>
          <Flag className="h-3 w-3" /> {t(PRIORITY_LABELS[task.priority])}
        </span>
      )}
      {project && (
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: project.color }} /> {project.name}
        </span>
      )}
      {task.tags.map((tag) => <span key={tag}>#{tag}</span>)}
      {checklist && (
        <span className="flex items-center gap-1" aria-label={t('Checklist: {done} of {total} done', { done: checklist.done, total: checklist.total })}>
          <ListChecks className="h-3 w-3" /> {checklist.done}/{checklist.total}
        </span>
      )}
      {subtasks.length > 0 && (
        <span className="flex items-center gap-1"
          aria-label={t('Subtasks: {done} of {total} done', { done: subtasks.filter((s) => s.status === 'done').length, total: subtasks.length })}>
          <ListTree className="h-3 w-3" /> {subtasks.filter((t) => t.status === 'done').length}/{subtasks.length}
        </span>
      )}
      {parent && (
        <span className="flex min-w-0 items-center gap-1" title={t('Subtask of “{title}”', { title: parent.title })}>
          <CornerDownRight className="h-3 w-3 shrink-0" /> <span className="truncate">{parent.title}</span>
        </span>
      )}
    </span>
  )
}

interface TaskRowProps {
  task: Task
  projects: Map<string, Project>
  info: TaskInfo
  /** Open a task in the editor. */
  onOpen: (task: Task) => void
  /** Whether the start of a task's notes is shown under it. */
  notesShown: (id: string) => boolean
  onToggleNotes: (id: string) => void
  /** A link led to this task: it is scrolled into view and marked for a moment. */
  linkedId?: string | null
  /** A subtask shown under its parent. */
  nested?: boolean
}

/**
 * One line in the task list: a checkbox to complete it, and the task itself (opens it).
 * A task with notes has an arrow that shows the start of them under the line; a task
 * with subtasks has one that shows them, folded in under it.
 */
export function TaskRow({ task, projects, info, onOpen, notesShown, onToggleNotes, linkedId = null, nested = false }: TaskRowProps) {
  const { toggle } = useToggleDone()
  const remove = useDeleteTask()
  const create = useCreateTask()
  const done = task.status === 'done'
  const finished = done || task.status === 'cancelled'
  const hasNotes = task.description.trim() !== ''
  const expanded = notesShown(task.id)
  const linked = linkedId === task.id
  const project = task.project_id ? projects.get(task.project_id) : undefined
  const subtasks = nested ? [] : subtasksOf(info.all, task.id)
  const [showSubtasks, setShowSubtasks] = useState(() => subtasks.some((t) => t.id === linkedId))
  // A link to one of its subtasks unfolds them.
  if (linkedId && !showSubtasks && subtasks.some((t) => t.id === linkedId)) setShowSubtasks(true)

  const row = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (linked) row.current?.scrollIntoView({ block: 'center' })
  }, [linked])

  // No question asked: it is a finished task, and Undo puts it back as it was.
  // (mutateAsync: this row is often gone before the answer arrives, and mutate's own
  // onSuccess is skipped for a component that is no longer there.)
  const removeNow = () =>
    void remove.mutateAsync(task.id).then(
      () =>
        toast({
          message: t('Deleted “{title}”', { title: task.title }),
          duration: 10_000, // time to notice and undo
          action: {
            label: t('Undo'),
            onClick: () =>
              create.mutate({
                title: task.title, description: task.description, status: task.status, priority: task.priority,
                due_date: task.due_date, due_time: task.due_time, remind_minutes: task.remind_minutes,
                tags: task.tags, project_id: task.project_id, checklist: task.checklist,
                // The parent may be gone too; then it comes back as an ordinary task.
                parent_id: task.parent_id && info.byId.has(task.parent_id) ? task.parent_id : null,
                blocked_by: task.blocked_by.filter((id) => info.byId.has(id)),
              }),
          },
        }),
      () => undefined, // shown by the mutation's error state
    )
  const side = '-my-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-subtle hover:bg-surface-2 disabled:opacity-50 pointer-coarse:-my-2 pointer-coarse:h-10 pointer-coarse:w-10'

  return (
    <div ref={row} aria-current={linked || undefined} className={cn('rounded-control', linked && 'flash')}>
      <div className="group flex items-start gap-3 rounded-control px-2 py-2 hover:bg-surface-hover">
        <button type="button" role="checkbox" aria-checked={done} aria-label={done ? t('Reopen “{title}”', { title: task.title }) : t('Complete “{title}”', { title: task.title })}
          onClick={() => void toggle(task)}
          className={cn('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors pointer-coarse:h-6 pointer-coarse:w-6',
            done ? 'border-success bg-success text-white' : 'border-border-strong hover:border-accent')}>
          {done && <Check className="h-3 w-3" strokeWidth={3} />}
        </button>
        <button type="button" onClick={() => onOpen(task)} className="min-w-0 flex-1 text-left">
          <span className={cn('block break-words text-[14px]', finished && 'text-muted line-through')}>
            {task.title}
          </span>
          <TaskMeta task={task} project={project} info={info} nested={nested} />
        </button>
        {task.status === 'in_progress' && <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-accent">{t('In progress')}</span>}
        {task.status === 'waiting' && <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted">{t('Waiting')}</span>}
        {openBlockers(task, info.byId).length > 0 && !finished
          ? <BlockedBadge task={task} info={info} />
          : task.status === 'blocked' && <span className="shrink-0 rounded-full bg-warning/12 px-2 py-0.5 text-[11px] text-warning">{t('Blocked')}</span>}
        {subtasks.length > 0 && (
          <button type="button" aria-expanded={showSubtasks} aria-label={t('Subtasks of “{title}”', { title: task.title })}
            title={showSubtasks ? t('Hide subtasks') : t('Show subtasks')} onClick={() => setShowSubtasks(!showSubtasks)}
            className={cn(side, 'hover:text-text')}>
            <ListTree className={cn('h-4 w-4', showSubtasks && 'text-accent')} />
          </button>
        )}
        {hasNotes && (
          <button type="button" aria-expanded={expanded} aria-label={t('Notes of “{title}”', { title: task.title })} title={expanded ? t('Hide notes') : t('Show notes')}
            onClick={() => onToggleNotes(task.id)} className={cn(side, 'hover:text-text')}>
            <ChevronRight className={cn('h-4 w-4 transition-transform', expanded && 'rotate-90')} />
          </button>
        )}
        {!finished && (
          <ActionMenu label={t('More for “{title}”', { title: task.title })}
            className="-my-1 h-8 w-8 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 pointer-coarse:-my-2 pointer-coarse:h-10 pointer-coarse:w-10 pointer-coarse:opacity-100"
            actions={[
              { label: t('Focus on this'), icon: <Timer />, onSelect: () => focusOnTask(task) },
              { label: t('Open'), icon: <PanelRightOpen />, onSelect: () => onOpen(task) },
            ]} />
        )}
        {finished && (
          <button type="button" aria-label={t('Delete “{title}”', { title: task.title })} title={t('Delete')} disabled={remove.isPending} onClick={removeNow}
            className={cn(side, 'hover:text-error')}>
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>
      {hasNotes && expanded && (
        // The start of the notes: what fits in about seven lines, fading out when there is more.
        <div className="mb-2 ml-10 mr-2 border-l-2 border-border pl-3 pointer-coarse:ml-11">
          <div className="max-h-44 overflow-hidden text-muted [mask-image:linear-gradient(to_bottom,black_8rem,transparent_11rem)] [&_.markdown]:text-[13px] [&_.markdown]:leading-6">
            <Markdown text={task.description} />
          </div>
          <button type="button" onClick={() => onOpen(task)} className="mt-1 text-[12.5px] font-medium text-accent hover:underline">
            {t('Open task')}
          </button>
        </div>
      )}
      {showSubtasks && subtasks.length > 0 && (
        // Folded in under the parent, with a line down the side like the notes.
        <div role="group" aria-label={t('Subtasks of “{title}”', { title: task.title })} className="mb-1 ml-5 border-l-2 border-border pl-2 pointer-coarse:ml-6">
          {subtasks.map((sub) => (
            <TaskRow key={sub.id} task={sub} projects={projects} info={info} onOpen={onOpen} notesShown={notesShown}
              onToggleNotes={onToggleNotes} linkedId={linkedId} nested />
          ))}
        </div>
      )}
    </div>
  )
}
