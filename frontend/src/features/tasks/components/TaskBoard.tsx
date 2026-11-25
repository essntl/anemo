/**
 * Tasks by status, as a board (features/board): To do, In progress, Waiting, Blocked
 * and Done; cancelled tasks are left out. Moving a card changes the task's status and
 * its place in the column; the board shows it at once and goes back if the server
 * refuses (with a toast saying why). Used by the Tasks page and the Home widget.
 */
import { Link } from 'react-router'
import { errorMessage } from '@/api/client'
import { toast } from '@/components/ui/toast'
import { Board, type BoardColumn, type BoardMove } from '@/features/board/Board'
import { t } from '@/lib/i18n'
import { type Project, STATUS_LABELS, type Task, type TaskStatus, useReorderTasks } from '../api'
import { BOARD_STATUSES, boardColumn, columnOrder, type DoneWindow } from '../board'
import { askAboutSubtasks, openSubtasksLeft } from '../relations'
import type { TaskInfo } from './TaskRow'
import { TaskCard } from './TaskCard'

interface TaskBoardProps {
  tasks: Task[]
  /** Every task (also those the filters hide), for subtasks, what tasks wait on, and the order of whole columns. */
  info: TaskInfo
  projects: Map<string, Project>
  onOpen: (task: Task) => void
  onAdd: (status: TaskStatus) => void
  done?: DoneWindow
  /** The board's name for screen readers (several boards on a page: one per project). */
  label?: string
  cardsClassName?: string
}

export function TaskBoard({ tasks, info, projects, onOpen, onAdd, done, label, cardsClassName }: TaskBoardProps) {
  const reorder = useReorderTasks()

  const columns: BoardColumn<Task>[] = BOARD_STATUSES.map((status) => ({
    id: status,
    label: t(STATUS_LABELS[status]),
    items: boardColumn(tasks, status, done),
    ordered: status !== 'done',
    add: status === 'done' ? undefined : { label: t('Add a task to {status}', { status: t(STATUS_LABELS[status]) }), onAdd: () => onAdd(status) },
    footer: status === 'done' && done ? (
      <Link to={done.allTo} className="mt-2 block rounded-md px-1.5 py-1 text-[12px] font-medium text-accent hover:underline">
        {t('Show all')}
      </Link>
    ) : undefined,
  }))

  const move = async ({ id, to, order }: BoardMove) => {
    const status = to as TaskStatus
    // Into "Done" with open subtasks: finish them too, or keep them open?
    const moving = info.byId.get(id)
    const left = status === 'done' && moving?.status !== 'done' ? openSubtasksLeft(info.all, [id]) : 0
    const choice = await askAboutSubtasks(left)
    if (choice === null) return
    // Done sorts itself (latest first): only the task that goes there.
    const orderedIds = status === 'done' ? [id] : columnOrder(info.all, status, order, id)
    reorder.mutate({ status, orderedIds, subtasks: choice }, { onError: (err) => toast({ message: errorMessage(err) }) })
  }

  return (
    <Board label={label ?? t('Tasks by status')} columns={columns} itemId={(task) => task.id} itemLabel={(task) => task.title}
      onOpen={onOpen} onMove={(m) => void move(m)} cardsClassName={cardsClassName}
      renderCard={(task) => <TaskCard task={task} project={task.project_id ? projects.get(task.project_id) : undefined} info={info} />} />
  )
}
