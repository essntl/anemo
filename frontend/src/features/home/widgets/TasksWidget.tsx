import { useMemo, useState } from 'react'
import { SquareCheckBig } from 'lucide-react'
import { inScope, useScope } from '@/app/projectStore'
import { Select } from '@/components/ui/Select'
import { useCreateTask, useProjects, useTasks } from '@/features/tasks/api'
import { addDays, localDay, today as todayKey } from '@/features/tasks/dates'
import { rich, t } from '@/lib/i18n'
import type { WidgetLayout } from '../layout'
import { ROWS } from './rows'
import { MoreLink, QuickAdd, TaskLine, WidgetHeader } from './parts'

type Due = 'all' | 'today' | 'week' | 'none'

/** Tasks: open tasks with a project and a due filter, "x done · y open", and quick-add. */
export function TasksWidget({ item }: { item: WidgetLayout }) {
  const scope = useScope()
  const projects = useProjects()
  const tasks = useTasks()
  const create = useCreateTask()
  // What the sidebar's switcher shows, unless a project (or everything) is picked here.
  const [projectPick, setProjectPick] = useState<string | null>(null)
  const projectId = projectPick ?? (scope.kind === 'project' ? scope.project.id : '')
  // The first choice: all projects, or in Uncategorized (until something is picked here) only what is in none.
  const unfiled = scope.kind === 'uncategorized' && projectPick === null
  const [due, setDue] = useState<Due>('all')
  const today = todayKey()

  const { open, doneToday } = useMemo(() => {
    const mine = (tasks.data ?? []).filter((t) => (projectId ? t.project_id === projectId : !unfiled || inScope(scope, t.project_id)))
    const open = mine
      .filter((t) => t.status !== 'done' && t.status !== 'cancelled')
      .filter((t) => due === 'all' || (due === 'none' ? !t.due_date : !!t.due_date && t.due_date <= (due === 'today' ? today : addDays(today, 7))))
      .sort((a, b) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999') || b.priority - a.priority)
    const doneToday = mine.filter((t) => t.status === 'done' && t.completed_at && localDay(t.completed_at) >= today).length
    return { open, doneToday }
  }, [tasks.data, projectId, unfiled, scope, due, today])

  const rows = ROWS[item.h]
  return (
    <>
      <WidgetHeader title={t('Tasks')} icon={<SquareCheckBig />} to="/tasks">
        <span className="shrink-0 text-[12px] text-muted tabular-nums">
          {rich('<b>{done}</b> done · <b>{open}</b> open', { b: (c) => <span className="font-semibold text-text">{c}</span> }, { done: doneToday, open: open.length })}
        </span>
      </WidgetHeader>
      <div className="flex-1 px-2 pb-3">
        <div className="mb-1.5 flex flex-wrap gap-1.5 px-2">
          <Select variant="pill" aria-label={t('Project')} value={projectId} onValueChange={(v) => setProjectPick(v)}
            options={[{ value: '', label: unfiled ? t('Uncategorized') : t('All projects') }, ...(projects.data ?? []).filter((p) => !p.archived).map((p) => ({ value: p.id, label: p.name }))]} />
          <Select variant="pill" aria-label={t('Due')} value={due} onValueChange={(v) => setDue(v as Due)}
            options={[{ value: 'all', label: t('Any time') }, { value: 'today', label: t('Due today') }, { value: 'week', label: t('Due this week') }, { value: 'none', label: t('No date') }]} />
        </div>
        <div className="px-2">
          <QuickAdd placeholder={t('Add a task')} busy={create.isPending} onAdd={(title) => create.mutateAsync({ title, project_id: projectId || null })} />
        </div>
        {tasks.isSuccess && open.length === 0 && <p className="px-2 py-2 text-[13px] text-muted">{t('No open tasks here.')}</p>}
        <ul className="flex flex-col">
          {open.slice(0, rows).map((t) => <TaskLine key={t.id} task={t} />)}
        </ul>
        <MoreLink to="/tasks" count={open.length - rows} />
      </div>
    </>
  )
}
