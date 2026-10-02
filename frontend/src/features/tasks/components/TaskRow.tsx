import { useEffect, useRef } from 'react'
import { Bell, CalendarDays, Check, ChevronRight, Flag, Trash2 } from 'lucide-react'
import { Markdown } from '@/components/ui/Markdown'
import { toast } from '@/components/ui/toast'
import { cn } from '@/lib/cn'
import { PRIORITY_LABELS, type Project, type Task, useCreateTask, useDeleteTask, useUpdateTask } from '../api'
import { bucketOf, formatDue } from '../dates'

const PRIORITY_TONE = ['', 'text-muted', 'text-warning', 'text-error']

/** The small facts under a task's title: due date, priority, project, tags. */
export function TaskMeta({ task, project }: { task: Task; project?: Project }) {
  const open = task.status !== 'done' && task.status !== 'cancelled'
  const overdue = open && bucketOf(task) === 'overdue'
  return (
    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[12px] text-muted">
      {task.due_date && (
        <span className={cn('flex items-center gap-1', overdue && 'font-medium text-error')}>
          <CalendarDays className="h-3 w-3" /> {formatDue(task)}
          {task.remind_minutes != null && <Bell className="h-3 w-3" aria-label="Has a reminder" />}
        </span>
      )}
      {task.priority > 0 && (
        <span className={cn('flex items-center gap-1', PRIORITY_TONE[task.priority])}>
          <Flag className="h-3 w-3" /> {PRIORITY_LABELS[task.priority]}
        </span>
      )}
      {project && (
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: project.color }} /> {project.name}
        </span>
      )}
      {task.tags.map((tag) => <span key={tag}>#{tag}</span>)}
    </span>
  )
}

interface TaskRowProps {
  task: Task
  project?: Project
  /** Open the task in the editor. */
  onOpen: (task: Task) => void
  /** Whether the start of its notes is shown under it. */
  expanded: boolean
  onToggleNotes: () => void
  /** A link led to this task: it is scrolled into view and marked for a moment. */
  linked?: boolean
}

/**
 * One line in the task list: a checkbox to complete it, and the task itself (opens it).
 * A task with notes has an arrow that shows the start of them under the line.
 */
export function TaskRow({ task, project, onOpen, expanded, onToggleNotes, linked = false }: TaskRowProps) {
  const update = useUpdateTask()
  const remove = useDeleteTask()
  const create = useCreateTask()
  const done = task.status === 'done'
  const finished = done || task.status === 'cancelled'
  const hasNotes = task.description.trim() !== ''

  const row = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (linked) row.current?.scrollIntoView({ block: 'center' })
  }, [linked])

  // No question asked: it is a finished task, and Undo puts it back as it was.
  const removeNow = () =>
    remove.mutate(task.id, {
      onSuccess: () =>
        toast({
          message: `Deleted “${task.title}”`,
          duration: 10_000, // time to notice and undo
          action: {
            label: 'Undo',
            onClick: () =>
              create.mutate({
                title: task.title, description: task.description, status: task.status, priority: task.priority,
                due_date: task.due_date, due_time: task.due_time, remind_minutes: task.remind_minutes,
                tags: task.tags, project_id: task.project_id,
              }),
          },
        }),
    })
  const side = '-my-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-subtle hover:bg-surface-2 disabled:opacity-50 pointer-coarse:-my-2 pointer-coarse:h-10 pointer-coarse:w-10'

  return (
    <div ref={row} aria-current={linked || undefined} className={cn('rounded-control', linked && 'flash')}>
      <div className="flex items-start gap-3 rounded-control px-2 py-2 hover:bg-surface-hover">
        <button type="button" role="checkbox" aria-checked={done} aria-label={done ? `Reopen “${task.title}”` : `Complete “${task.title}”`}
          onClick={() => update.mutate({ id: task.id, body: { status: done ? 'todo' : 'done' } })}
          className={cn('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors pointer-coarse:h-6 pointer-coarse:w-6',
            done ? 'border-success bg-success text-white' : 'border-border-strong hover:border-accent')}>
          {done && <Check className="h-3 w-3" strokeWidth={3} />}
        </button>
        <button type="button" onClick={() => onOpen(task)} className="min-w-0 flex-1 text-left">
          <span className={cn('block break-words text-[14px]', finished && 'text-muted line-through')}>
            {task.title}
          </span>
          <TaskMeta task={task} project={project} />
        </button>
        {task.status === 'in_progress' && <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-accent">In progress</span>}
        {task.status === 'blocked' && <span className="shrink-0 rounded-full bg-warning/12 px-2 py-0.5 text-[11px] text-warning">Blocked</span>}
        {hasNotes && (
          <button type="button" aria-expanded={expanded} aria-label={`Notes of “${task.title}”`} title={expanded ? 'Hide notes' : 'Show notes'}
            onClick={onToggleNotes} className={cn(side, 'hover:text-text')}>
            <ChevronRight className={cn('h-4 w-4 transition-transform', expanded && 'rotate-90')} />
          </button>
        )}
        {finished && (
          <button type="button" aria-label={`Delete “${task.title}”`} title="Delete" disabled={remove.isPending} onClick={removeNow}
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
            Open task
          </button>
        </div>
      )}
    </div>
  )
}
