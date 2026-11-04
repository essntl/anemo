import { type Task, useTasks, useUpdateTask } from './api'
import { askAboutSubtasks, openSubtasksLeft } from './relations'

/**
 * Complete a task, or reopen a finished one. Finishing a task with open subtasks asks
 * first whether to finish them too (cancelling leaves everything as it was).
 */
export function useToggleDone() {
  const update = useUpdateTask()
  const all = useTasks().data ?? []
  const toggle = async (task: Task) => {
    if (task.status === 'done') return update.mutate({ id: task.id, body: { status: 'todo' } })
    const choice = await askAboutSubtasks(openSubtasksLeft(all, [task.id]))
    if (choice === null) return
    update.mutate({ id: task.id, body: { status: 'done', ...(choice ? { subtasks: choice } : {}) } })
  }
  return { toggle, update }
}
