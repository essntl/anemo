/**
 * Board view: one column per status. Drag a card to another column (or to another
 * position) with the mouse; on touch screens open the task and change its status.
 */
import { useState } from 'react'
import { Plus } from 'lucide-react'
import { cn } from '@/lib/cn'
import { type Project, STATUS_LABELS, type Task, type TaskStatus, useReorderTasks } from '../api'
import { TaskMeta } from './TaskRow'

const COLUMNS: TaskStatus[] = ['todo', 'in_progress', 'blocked', 'done']
const MAX_DONE = 30 // the Done column only shows the latest ones

interface TaskBoardProps {
  tasks: Task[]
  projects: Map<string, Project>
  onOpen: (task: Task) => void
  onAdd: (status: TaskStatus) => void
}

export function TaskBoard({ tasks, projects, onOpen, onAdd }: TaskBoardProps) {
  const reorder = useReorderTasks()
  const [dragged, setDragged] = useState<string | null>(null)
  // Where the card would land: a column, and the card it would go in front of (null: the end).
  const [target, setTarget] = useState<{ status: TaskStatus; before: string | null } | null>(null)

  const column = (status: TaskStatus) => {
    const own = tasks.filter((t) => t.status === status)
    if (status !== 'done') return own.sort((a, b) => a.sort_order - b.sort_order)
    return own.sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? '')).slice(0, MAX_DONE)
  }

  const drop = () => {
    if (dragged && target) {
      const ids = column(target.status).map((t) => t.id).filter((id) => id !== dragged)
      const at = target.before ? ids.indexOf(target.before) : -1
      ids.splice(at < 0 ? ids.length : at, 0, dragged)
      reorder.mutate({ status: target.status, orderedIds: ids })
    }
    setDragged(null)
    setTarget(null)
  }

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {COLUMNS.map((status) => {
        const items = column(status)
        const isTarget = target?.status === status
        return (
          <section key={status} aria-label={STATUS_LABELS[status]}
            onDragOver={(e) => {
              e.preventDefault()
              if (target?.status !== status) setTarget({ status, before: null })
            }}
            onDrop={drop}
            className={cn('flex w-72 shrink-0 flex-col rounded-card border border-border bg-surface-2/50 p-2 transition-colors',
              isTarget && dragged && 'border-accent bg-accent-soft/40')}>
            <header className="flex items-center justify-between px-1.5 pb-2 pt-1 text-[12.5px] font-semibold text-muted">
              <span>{STATUS_LABELS[status]} <span className="font-normal text-subtle">{items.length}</span></span>
              {status !== 'done' && (
                <button type="button" aria-label={`Add a task to ${STATUS_LABELS[status]}`} onClick={() => onAdd(status)}
                  className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-surface-hover hover:text-text pointer-coarse:h-9 pointer-coarse:w-9">
                  <Plus className="h-3.5 w-3.5" />
                </button>
              )}
            </header>
            <div className="flex min-h-16 flex-col gap-1.5">
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
                  <TaskMeta task={task} project={task.project_id ? projects.get(task.project_id) : undefined} />
                </div>
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}
