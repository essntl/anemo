/**
 * How tasks hang together: checklists, subtasks (one level deep) and the tasks one
 * waits on ("blocked by"). The page has every task loaded, so all of this is worked out
 * from that list; the server checks the same rules when something is saved.
 */
import { chooseDialog } from '@/components/ui/dialogs'
import { plural, t } from '@/lib/i18n'
import type { Task } from './api'

export type ChecklistItem = Task['checklist'][number]
export type SubtasksChoice = 'finish' | 'keep'

export const isOpen = (t: Pick<Task, 'status'>) => t.status !== 'done' && t.status !== 'cancelled'

export function byId(all: Task[]): Map<string, Task> {
  return new Map(all.map((t) => [t.id, t]))
}

/** "3/5": how many checklist items are ticked; null without a checklist. */
export function checklistProgress(items: ChecklistItem[]): { done: number; total: number } | null {
  if (items.length === 0) return null
  return { done: items.filter((i) => i.done).length, total: items.length }
}

export function subtasksOf(all: Task[], parentId: string): Task[] {
  return all.filter((t) => t.parent_id === parentId).sort((a, b) => a.created_at.localeCompare(b.created_at))
}

/** The tasks `task` waits on that are still open (the ones that block it). */
export function openBlockers(task: Task, tasks: Map<string, Task>): Task[] {
  return task.blocked_by.map((id) => tasks.get(id)).filter((t): t is Task => t !== undefined && isOpen(t))
}

/** The tasks that wait on this one. */
export function waitingOn(all: Task[], taskId: string): Task[] {
  return all.filter((t) => t.blocked_by.includes(taskId))
}

/** Every task that waits on `taskId`, directly or through others. */
function downstream(all: Task[], taskId: string): Set<string> {
  const found = new Set<string>()
  let frontier = [taskId]
  while (frontier.length) {
    const next: string[] = []
    for (const t of all) {
      if (!found.has(t.id) && t.id !== taskId && t.blocked_by.some((b) => frontier.includes(b))) {
        found.add(t.id)
        next.push(t.id)
      }
    }
    frontier = next
  }
  return found
}

/**
 * Tasks `taskId` could wait on: not itself, not one it already waits on, and not one
 * that (through others) waits on it, which would make a loop. Open ones first.
 * `taskId` null: a task that doesn't exist yet, which nothing waits on.
 */
export function blockerCandidates(all: Task[], taskId: string | null, chosen: string[]): Task[] {
  const loops = taskId ? downstream(all, taskId) : new Set<string>()
  return all
    .filter((t) => t.id !== taskId && !chosen.includes(t.id) && !loops.has(t.id) && t.status !== 'cancelled')
    .sort((a, b) => Number(!isOpen(a)) - Number(!isOpen(b)) || a.title.localeCompare(b.title))
}

/**
 * Tasks `task` could become a subtask of: open tasks that are not subtasks themselves.
 * None when `task` has subtasks of its own (one level deep).
 */
export function parentCandidates(all: Task[], task: Task | null): Task[] {
  if (task && all.some((t) => t.parent_id === task.id)) return []
  return all
    .filter((t) => t.id !== task?.id && t.parent_id === null && isOpen(t))
    .sort((a, b) => a.title.localeCompare(b.title))
}

/**
 * How many open subtasks would be left behind when these tasks are finished (the
 * subtasks that are finished along with them don't count).
 */
export function openSubtasksLeft(all: Task[], finishing: string[]): number {
  const ids = new Set(finishing)
  return all.filter((t) => t.parent_id !== null && ids.has(t.parent_id) && !ids.has(t.id) && isOpen(t)).length
}

/**
 * Finishing a task with open subtasks: ask whether to finish them too. Resolves with
 * the choice, undefined when there was nothing to ask, or null when cancelled.
 */
export async function askAboutSubtasks(open: number): Promise<SubtasksChoice | undefined | null> {
  if (open === 0) return undefined
  const answer = await chooseDialog({
    title: plural(open, 'It has an open subtask', 'It has {n} open subtasks'),
    message: t('Finish them along with it, or keep them open?'),
    options: [
      { value: 'finish', label: open === 1 ? t('Finish it too') : t('Finish them too') },
      { value: 'keep', label: open === 1 ? t('Keep it open') : t('Keep them open') },
    ],
  })
  return answer === 'finish' || answer === 'keep' ? answer : null
}

/** A checklist item to add, with an id of its own (kept by the server). */
export function newItem(text: string): ChecklistItem {
  const id = Array.from({ length: 8 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  return { id, text: text.trim(), done: false }
}
