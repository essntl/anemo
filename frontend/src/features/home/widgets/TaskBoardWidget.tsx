/**
 * Task board: where everything stands, by status (the Tasks page's board). Done shows
 * the last seven days. Filters by project, tag and when due, and optionally a lane
 * per project; they are kept with the widget, so the board opens as it was left.
 * A card opens the task in its editor, right here.
 */
import { useMemo, useState } from 'react'
import { KanbanSquare } from 'lucide-react'
import { useScope } from '@/app/projectStore'
import { Lingering } from '@/components/ui/Lingering'
import { Select } from '@/components/ui/Select'
import { type Project, type Task, type TaskStatus, useProjects, useTasks } from '@/features/tasks/api'
import { type DoneWindow, onBoard } from '@/features/tasks/board'
import { TaskBoard } from '@/features/tasks/components/TaskBoard'
import { TaskDialog } from '@/features/tasks/components/TaskDialog'
import type { TaskInfo } from '@/features/tasks/components/TaskRow'
import { today as todayKey } from '@/features/tasks/dates'
import { byId, isOpen } from '@/features/tasks/relations'
import { plural, t } from '@/lib/i18n'
import type { WidgetLayout } from '../layout'
import { type BoardDue, type BoardFilters, filterTasks, lanesOf, projectShown, readFilters, writeFilters } from '../taskBoard'
import { WidgetHeader } from './parts'

const DONE: DoneWindow = { days: 7, allTo: '/tasks' }
/** How tall a column's cards may get before they scroll, by the widget's height in rows. */
const CARDS_HEIGHT = ['', 'max-h-44', 'max-h-[25rem]', 'max-h-[40rem]']

/** The task editor: an existing task, or a new one starting in a status. */
type Editing = { task: Task | null; status?: TaskStatus } | null

export function TaskBoardWidget({ item, onOptions }: { item: WidgetLayout; onOptions: (options: Record<string, string | null>) => void }) {
  const scope = useScope()
  const tasks = useTasks()
  const projects = useProjects()
  const [editing, setEditing] = useState<Editing>(null)
  const filters = readFilters(item.options)
  const set = (change: Partial<BoardFilters>) => onOptions(writeFilters({ ...filters, ...change }))
  const { projectId, unfiled } = projectShown(filters, scope)

  const all = useMemo(() => tasks.data ?? [], [tasks.data])
  const info = useMemo<TaskInfo>(() => ({ all, byId: byId(all) }), [all])
  const projectList = useMemo(() => (projects.data ?? []).filter((p) => !p.archived), [projects.data])
  const projectMap = useMemo(() => new Map<string, Project>((projects.data ?? []).map((p) => [p.id, p])), [projects.data])
  const tags = useMemo(() => [...new Set(all.flatMap((task) => task.tags))].sort(), [all])
  const shown = filterTasks(all, filters, scope, todayKey())
  const open = shown.filter((task) => isOpen(task)).length

  const board = (list: Task[], label?: string) => (
    <TaskBoard tasks={list} info={info} projects={projectMap} done={DONE} label={label}
      cardsClassName={`${CARDS_HEIGHT[item.h]} overflow-y-auto overscroll-contain`}
      onOpen={(task) => setEditing({ task })} onAdd={(status) => setEditing({ task: null, status })} />
  )

  return (
    <>
      <WidgetHeader title={t('Task board')} icon={<KanbanSquare />} to="/tasks?view=board">
        {tasks.isSuccess && <span className="shrink-0 text-[12px] text-muted tabular-nums">{plural(open, '{n} open', '{n} open')}</span>}
      </WidgetHeader>
      <div className="mb-2 flex flex-wrap gap-1.5 px-4">
        <Select variant="pill" aria-label={t('Project')} value={projectId} onValueChange={(v) => set({ project: v })}
          options={[{ value: '', label: unfiled ? t('Uncategorized') : t('All projects') }, ...projectList.map((p) => ({ value: p.id, label: p.name }))]} />
        {tags.length > 0 && (
          <Select variant="pill" aria-label={t('Tag')} value={filters.tag} onValueChange={(v) => set({ tag: v })}
            options={[{ value: '', label: t('All tags') }, ...tags.map((tag) => ({ value: tag, label: `#${tag}` }))]} />
        )}
        <Select variant="pill" aria-label={t('Due')} value={filters.due} onValueChange={(v) => set({ due: v as BoardDue })}
          options={[{ value: 'all', label: t('Any time') }, { value: 'overdue', label: t('Overdue') }, { value: 'week', label: t('Due this week') }]} />
        <Select variant="pill" aria-label={t('Lanes')} value={filters.lanes ? 'project' : ''} onValueChange={(v) => set({ lanes: v === 'project' })}
          options={[{ value: '', label: t('One board') }, { value: 'project', label: t('A lane per project') }]} />
      </div>
      <div className="min-h-0 flex-1 px-3 pb-3">
        {tasks.isError && <p className="px-1 text-[13px] text-error">{t('Could not load the tasks.')}</p>}
        {tasks.isSuccess && !filters.lanes && board(shown)}
        {tasks.isSuccess && filters.lanes && (
          <div className="flex flex-col gap-3">
            {lanesOf(onBoard(shown, DONE), projectList).map((lane) => {
              const name = lane.project?.name ?? t('No project')
              return (
                <section key={lane.id || '-'} aria-label={name}>
                  <h3 className="mb-1.5 flex items-center gap-2 px-1 text-[12.5px] font-semibold">
                    {lane.project
                      ? <span aria-hidden className="h-2 w-2 rounded-full" style={{ backgroundColor: lane.project.color }} />
                      : <span aria-hidden className="h-2 w-2 rounded-full border border-border-strong" />}
                    {name} <span className="font-normal text-subtle tabular-nums">{lane.tasks.length}</span>
                  </h3>
                  {board(lane.tasks, t('{project}: tasks by status', { project: name }))}
                </section>
              )
            })}
            {shown.length === 0 && <p className="px-1 text-[13px] text-muted">{t('No tasks match these filters.')}</p>}
          </div>
        )}
      </div>
      <Lingering value={editing}>
        {(current) => (
          <TaskDialog key={current.task?.id ?? 'new'} task={current.task} onClose={() => setEditing(null)}
            onOpenTask={(task) => setEditing({ task })}
            defaults={{ status: current.status, project_id: projectId || null }} />
        )}
      </Lingering>
    </>
  )
}
