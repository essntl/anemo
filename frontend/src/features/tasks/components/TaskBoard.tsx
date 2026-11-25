/**
 * Board view: one column per status, side by side; on a phone they are stacked, so
 * nothing scrolls sideways. Drag a card to another column (or to another position)
 * with the mouse; on touch screens open the task and change its status.
 */
import { errorMessage } from '@/api/client'
import { Board, type BoardColumn, type BoardMove } from '@/features/board/Board'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { type Project, STATUS_LABELS, type Task, type TaskStatus, useReorderTasks } from '../api'
import { askAboutSubtasks, openSubtasksLeft } from '../relations'
import { BlockedBadge, type TaskInfo, TaskMeta } from './TaskRow'

const COLUMNS: TaskStatus[] = ['todo', 'in_progress', 'waiting', 'blocked', 'done']
const MAX_DONE = 30 // the Done column only shows the latest ones

interface TaskBoardProps {
  tasks: Task[]
  /** Every task (also those the filters hide), for subtasks and what tasks wait on. */
  info: TaskInfo
  projects: Map<string, Project>
  onOpen: (task: Task) => void
  onAdd: (status: TaskStatus) => void
}

export function TaskBoard({ tasks, info, projects, onOpen, onAdd }: TaskBoardProps) {
  const reorder = useReorderTasks()

  const column = (status: TaskStatus) => {
    const own = tasks.filter((t) => t.status === status)
    if (status !== 'done') return own.sort((a, b) => a.sort_order - b.sort_order)
    return own.sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? '')).slice(0, MAX_DONE)
  }

  const columns: BoardColumn<Task>[] = COLUMNS.map((status) => ({
    id: status,
    label: t(STATUS_LABELS[status]),
    items: column(status),
    add: status === 'done' ? undefined : { label: t('Add a task to {status}', { status: t(STATUS_LABELS[status]) }), onAdd: () => onAdd(status) },
  }))

  const move = async ({ id, to, order }: BoardMove) => {
    const status = to as TaskStatus
    // Into "Done" with open subtasks: finish them too, or keep them open?
    const moving = info.byId.get(id)
    const left = status === 'done' && moving?.status !== 'done' ? openSubtasksLeft(info.all, [id]) : 0
    const choice = await askAboutSubtasks(left)
    if (choice === null) return
    reorder.mutate({ status, orderedIds: order, subtasks: choice })
  }

  return (
    <>
    {reorder.error && <p className="mb-2 text-[13px] text-error">{errorMessage(reorder.error)}</p>}
    <Board columns={columns} itemId={(task) => task.id} onOpen={onOpen} onMove={(m) => void move(m)}
      renderCard={(task) => (
        <>
          <div className={cn('break-words text-[13.5px]', task.status === 'done' && 'text-muted line-through')}>{task.title}</div>
          <TaskMeta task={task} project={task.project_id ? projects.get(task.project_id) : undefined} info={info} />
          <div className="mt-1 flex empty:hidden"><BlockedBadge task={task} info={info} /></div>
        </>
      )} />
    </>
  )
}
