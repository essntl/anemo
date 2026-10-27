import { useToday } from '@/hooks/useNow'
import { useMemo } from 'react'
import { Link } from 'react-router'
import { CalendarDays } from 'lucide-react'
import { useCurrentProject } from '@/app/projectStore'
import { useOccurrences, type Occurrence } from '@/features/calendar/api'
import { type Task, useCreateTask, useTasks } from '@/features/tasks/api'
import { dayOf } from '@/features/tasks/dates'
import { dayRange, timeOf } from '../dates'
import type { WidgetLayout } from '../layout'
import { ROWS } from './rows'
import { MoreLink, QuickAdd, TaskLine, WidgetHeader } from './parts'

type Entry = { kind: 'task'; task: Task; sort: string } | { kind: 'event'; event: Occurrence; sort: string }

/** Today: overdue tasks first, then today's tasks and events in time order; quick-add for today. */
export function TodayWidget({ item }: { item: WidgetLayout }) {
  const project = useCurrentProject()
  const tasks = useTasks()
  const create = useCreateTask()
  const day = useToday()
  const range = useMemo(() => dayRange(new Date(day)), [day])
  const events = useOccurrences(range, project?.id ?? null)
  const today = dayOf(new Date(day))

  const { overdue, entries, doneToday } = useMemo(() => {
    const mine = (tasks.data ?? []).filter((t) => !project || t.project_id === project.id)
    const open = mine.filter((t) => t.status !== 'done' && t.status !== 'cancelled')
    const overdue = open.filter((t) => t.due_date && t.due_date < today).sort((a, b) => a.due_date!.localeCompare(b.due_date!))
    const entries: Entry[] = [
      ...open.filter((t) => t.due_date === today).map((t): Entry => ({ kind: 'task', task: t, sort: t.due_time ?? '99' })),
      ...(events.data ?? []).map((e): Entry => ({ kind: 'event', event: e, sort: e.all_day ? '00' : timeOf(e.start_at) })),
    ].sort((a, b) => a.sort.localeCompare(b.sort))
    const doneToday = mine.filter((t) => t.status === 'done' && t.completed_at && t.completed_at.slice(0, 10) >= today).length
    return { overdue, entries, doneToday }
  }, [tasks.data, events.data, project, today])

  const rows = ROWS[item.h] + (item.h === 1 ? 0 : 1)
  const shownOverdue = overdue.slice(0, rows)
  const shownEntries = entries.slice(0, Math.max(0, rows - shownOverdue.length))
  const rest = overdue.length + entries.length - shownOverdue.length - shownEntries.length
  return (
    <>
      <WidgetHeader title="Today" icon={<CalendarDays />} to="/calendar" />
      <div className="flex-1 px-2 pb-3">
        <div className="px-2">
          <QuickAdd placeholder="Add a task for today" busy={create.isPending}
            onAdd={(title) => create.mutateAsync({ title, due_date: today, project_id: project?.id ?? null })} />
        </div>
        {tasks.isSuccess && overdue.length === 0 && entries.length === 0 && (
          <p className="px-2 py-4 text-center text-[13px] text-muted">
            {doneToday ? `All clear: ${doneToday} done today.` : 'Nothing scheduled. A clear day for deep work.'}
          </p>
        )}
        <ul className="flex flex-col">
          {shownOverdue.map((t) => <TaskLine key={t.id} task={t} />)}
          {shownEntries.map((e) =>
            e.kind === 'task' ? (
              <TaskLine key={e.task.id} task={e.task} />
            ) : (
              <li key={`${e.event.id}-${e.event.start_at}`}>
                <Link to={`/calendar?date=${today}`} className="flex items-center gap-2.5 rounded-control px-2 py-1.5 hover:bg-surface-hover">
                  <span className="h-6 w-1 shrink-0 rounded-full" style={{ background: e.event.color ?? 'var(--accent)' }} />
                  <span className="min-w-0 flex-1 truncate text-[13.5px]">{e.event.title}</span>
                  <span className="shrink-0 text-[11.5px] text-muted tabular-nums">{e.event.all_day ? 'All day' : timeOf(e.event.start_at)}</span>
                </Link>
              </li>
            ),
          )}
        </ul>
        <MoreLink to="/tasks" count={rest} />
      </div>
    </>
  )
}
