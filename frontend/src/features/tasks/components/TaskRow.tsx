import { Bell, CalendarDays, Check, Flag } from 'lucide-react'
import { cn } from '@/lib/cn'
import { PRIORITY_LABELS, type Project, type Task, useUpdateTask } from '../api'
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

/** One line in the task list: a checkbox to complete it, and the task itself (opens it). */
export function TaskRow({ task, project, onOpen }: { task: Task; project?: Project; onOpen: (task: Task) => void }) {
  const update = useUpdateTask()
  const done = task.status === 'done'
  return (
    <div className="flex items-start gap-3 rounded-control px-2 py-2 hover:bg-surface-hover">
      <button type="button" role="checkbox" aria-checked={done} aria-label={done ? `Reopen “${task.title}”` : `Complete “${task.title}”`}
        onClick={() => update.mutate({ id: task.id, body: { status: done ? 'todo' : 'done' } })}
        className={cn('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors pointer-coarse:h-6 pointer-coarse:w-6',
          done ? 'border-success bg-success text-white' : 'border-border-strong hover:border-accent')}>
        {done && <Check className="h-3 w-3" strokeWidth={3} />}
      </button>
      <button type="button" onClick={() => onOpen(task)} className="min-w-0 flex-1 text-left">
        <span className={cn('block break-words text-[14px]', (done || task.status === 'cancelled') && 'text-muted line-through')}>
          {task.title}
        </span>
        <TaskMeta task={task} project={project} />
      </button>
      {task.status === 'in_progress' && <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-accent">In progress</span>}
      {task.status === 'blocked' && <span className="shrink-0 rounded-full bg-warning/12 px-2 py-0.5 text-[11px] text-warning">Blocked</span>}
    </div>
  )
}
