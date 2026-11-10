import { ListPlus, Plus, X } from 'lucide-react'
import { chooseDialog } from '@/components/ui/dialogs'
import { type Task, useTasks } from '@/features/tasks/api'
import { focusQueue, useFocusQueue } from '../queueStore'
import { timerActions, useTimerStore } from '../timerStore'

const isOpen = (t: Task) => t.status !== 'done' && t.status !== 'cancelled'

/**
 * Up next: the tasks lined up for the coming focus sessions. A task here takes over when
 * the one being worked on is marked done; clicking one starts on it now.
 */
export function UpNext() {
  const ids = useFocusQueue((s) => s.ids)
  const current = useTimerStore((s) => s.timer.taskId)
  const tasks = useTasks()
  const open = (tasks.data ?? []).filter(isOpen)
  const byId = new Map(open.map((t) => [t.id, t]))
  // Finished or deleted tasks simply aren't listed (they leave the queue when it moves on).
  const queued = ids.map((id) => byId.get(id)).filter((t): t is Task => t !== undefined)

  const add = async () => {
    const options = open
      .filter((t) => t.id !== current && !ids.includes(t.id))
      .slice(0, 100)
      .map((t) => ({ value: t.id, label: t.title }))
    const id = await chooseDialog({
      title: 'Queue a task', message: 'It comes up when the task you are on is done.', options,
      empty: 'No other open tasks. Add some in Tasks.',
    })
    if (id) focusQueue.add(id)
  }
  const startNow = (task: Task) => {
    focusQueue.remove(task.id)
    timerActions.setTask(task.id)
  }

  return (
    <div className="px-4 pb-3 pt-3 md:px-5">
      <div className="flex items-center justify-between text-[11.5px] font-semibold uppercase tracking-wider text-muted">
        <span className="flex items-center gap-1.5"><ListPlus className="h-4 w-4" /> Up next</span>
        {queued.length > 0 && <span className="text-[13px] normal-case tracking-normal text-text tabular-nums">{queued.length}</span>}
      </div>
      {queued.length === 0 && <p className="pt-2 text-[13px] text-muted">Line up the tasks for your next sessions.</p>}
      <ul className="mt-1">
        {queued.map((t) => (
          <li key={t.id} className="flex items-center gap-1 text-[13px]">
            <button type="button" onClick={() => startNow(t)} title="Work on this now"
              className="-ml-2 min-w-0 flex-1 truncate rounded-control px-2 py-1.5 text-left hover:bg-surface-hover">
              {t.title}
            </button>
            <button type="button" aria-label={`Take “${t.title}” off the queue`} onClick={() => focusQueue.remove(t.id)}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-hover hover:text-text pointer-coarse:h-10 pointer-coarse:w-10">
              <X className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => void add()}
        className="-ml-2 mt-1 flex h-8 items-center gap-1.5 rounded-control px-2 text-[13px] font-medium text-accent hover:bg-surface-hover pointer-coarse:h-10">
        <Plus className="h-3.5 w-3.5" /> Queue a task
      </button>
    </div>
  )
}
