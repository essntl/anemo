/**
 * Board view: one column per status, side by side; on a phone they are stacked, so
 * nothing scrolls sideways. Drag a card to another column (or to another position)
 * with the mouse; on touch screens open the task and change its status.
 */
import { useState } from 'react'
import { Plus } from 'lucide-react'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { errorMessage } from '@/api/client'
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
  const [dragged, setDragged] = useState<string | null>(null)
  // Where the card would land: a column, and the card it would go in front of (null: the end).
  const [target, setTarget] = useState<{ status: TaskStatus; before: string | null } | null>(null)

  const column = (status: TaskStatus) => {
    const own = tasks.filter((t) => t.status === status)
    if (status !== 'done') return own.sort((a, b) => a.sort_order - b.sort_order)
    return own.sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? '')).slice(0, MAX_DONE)
  }

  const drop = async () => {
    const [card, place] = [dragged, target]
    setDragged(null)
    setTarget(null)
    if (!card || !place) return
    const ids = column(place.status).map((t) => t.id).filter((id) => id !== card)
    const at = place.before ? ids.indexOf(place.before) : -1
    ids.splice(at < 0 ? ids.length : at, 0, card)
    // Into "Done" with open subtasks: finish them too, or keep them open?
    const moving = info.byId.get(card)
    const left = place.status === 'done' && moving?.status !== 'done' ? openSubtasksLeft(info.all, [card]) : 0
    const choice = await askAboutSubtasks(left)
    if (choice === null) return
    reorder.mutate({ status: place.status, orderedIds: ids, subtasks: choice })
  }

  return (
    <>
    {reorder.error && <p className="mb-2 text-[13px] text-error">{errorMessage(reorder.error)}</p>}
    <div className="flex flex-col gap-3 md:flex-row md:overflow-x-auto md:pb-2">
      {COLUMNS.map((status) => {
        const items = column(status)
        const isTarget = target?.status === status
        return (
          <section key={status} aria-label={t(STATUS_LABELS[status])}
            onDragOver={(e) => {
              e.preventDefault()
              if (target?.status !== status) setTarget({ status, before: null })
            }}
            onDrop={() => void drop()}
            className={cn('flex flex-col rounded-card md:w-72 md:shrink-0 border border-border bg-surface-2/50 p-2 transition-colors',
              isTarget && dragged && 'border-accent bg-accent-soft/40')}>
            <header className="flex items-center justify-between px-1.5 pb-2 pt-1 text-[12.5px] font-semibold text-muted">
              <span>{t(STATUS_LABELS[status])} <span className="font-normal text-subtle">{items.length}</span></span>
              {status !== 'done' && (
                <button type="button" aria-label={t('Add a task to {status}', { status: t(STATUS_LABELS[status]) })} onClick={() => onAdd(status)}
                  className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-surface-hover hover:text-text pointer-coarse:h-9 pointer-coarse:w-9">
                  <Plus className="h-3.5 w-3.5" />
                </button>
              )}
            </header>
            <div className="flex min-h-12 flex-col gap-1.5 md:min-h-16">
              {items.map((task) => (
                <div key={task.id} draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move'
                    setDragged(task.id)
                  }}
                  onDragEnd={() => { setDragged(null); setTarget(null) }}
                  onDragOver={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    if (target?.before !== task.id) setTarget({ status, before: task.id })
                  }}
                  onClick={() => onOpen(task)}
                  className={cn('cursor-pointer rounded-control border border-border bg-card px-3 py-2 shadow-soft hover:border-border-strong',
                    dragged === task.id && 'opacity-40',
                    dragged && target?.before === task.id && 'border-t-2 border-t-accent')}>
                  <div className={cn('break-words text-[13.5px]', status === 'done' && 'text-muted line-through')}>{task.title}</div>
                  <TaskMeta task={task} project={task.project_id ? projects.get(task.project_id) : undefined} info={info} />
                  <div className="mt-1 flex empty:hidden"><BlockedBadge task={task} info={info} /></div>
                </div>
              ))}
            </div>
          </section>
        )
      })}
    </div>
    </>
  )
}
