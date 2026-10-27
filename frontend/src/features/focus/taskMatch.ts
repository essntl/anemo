import type { Task } from '@/features/tasks/api'

export const OPEN_STATUSES = new Set(['todo', 'in_progress', 'blocked', 'waiting'])

/** Open tasks matching the search (all words), the chosen project's first. */
export function matchTasks(tasks: Task[], query: string, projectId: string | null): Task[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return tasks
    .filter((t) => OPEN_STATUSES.has(t.status))
    .filter((t) => words.every((w) => t.title.toLowerCase().includes(w)))
    .sort((a, b) => Number(b.project_id === projectId) - Number(a.project_id === projectId) || b.priority - a.priority)
}

