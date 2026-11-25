/**
 * A task on a board: its title with the project's colour, and in one line what matters
 * at a glance: when it is due (red when overdue), its priority, the checklist and
 * subtasks done so far, and what it waits on.
 */
import { CalendarDays, Flag, ListChecks, ListTree } from 'lucide-react'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { PRIORITY_LABELS, PRIORITY_TONE, type Project, type Task } from '../api'
import { bucketOf, formatDue } from '../dates'
import { checklistProgress, isOpen, subtasksOf } from '../relations'
import { BlockedBadge, type TaskInfo } from './TaskRow'

export function TaskCard({ task, project, info }: { task: Task; project?: Project; info: TaskInfo }) {
  const open = isOpen(task)
  const overdue = open && bucketOf(task) === 'overdue'
  const checklist = checklistProgress(task.checklist)
  const subtasks = subtasksOf(info.all, task.id)
  const subtasksDone = subtasks.filter((s) => s.status === 'done').length
  return (
    <>
      <div className="flex items-start gap-2">
        {project && (
          <span className="mt-[0.45em] h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: project.color }}
            title={project.name} role="img" aria-label={t('Project: {name}', { name: project.name })} />
        )}
        <span className={cn('min-w-0 flex-1 break-words text-[13.5px] leading-snug', !open && 'text-muted line-through')}>{task.title}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] text-muted tabular-nums">
        <span className={cn('flex items-center gap-1', overdue && 'font-medium text-error', !task.due_date && 'text-subtle')}>
          <CalendarDays className="h-3 w-3" aria-hidden />
          {task.due_date ? formatDue(task) : t('No date')}
          {overdue && <span className="sr-only">{t('Overdue')}</span>}
        </span>
        {task.priority > 0 && (
          <span className={cn('flex items-center gap-1', PRIORITY_TONE[task.priority])}>
            <Flag className="h-3 w-3" aria-hidden /> {t(PRIORITY_LABELS[task.priority])}
          </span>
        )}
        {checklist && (
          <span className="flex items-center gap-1" aria-label={t('Checklist: {done} of {total} done', { done: checklist.done, total: checklist.total })}>
            <ListChecks className="h-3 w-3" aria-hidden /> {checklist.done}/{checklist.total}
          </span>
        )}
        {subtasks.length > 0 && (
          <span className="flex items-center gap-1" aria-label={t('Subtasks: {done} of {total} done', { done: subtasksDone, total: subtasks.length })}>
            <ListTree className="h-3 w-3" aria-hidden /> {subtasksDone}/{subtasks.length}
          </span>
        )}
        <BlockedBadge task={task} info={info} />
      </div>
    </>
  )
}
