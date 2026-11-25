/** Which tasks a status board shows in each column, and in what order (pure, no React). */
import { mergeIntoFull } from '@/features/board/placement'
import type { Task, TaskStatus } from './api'

/** The columns, left to right. Cancelled tasks are not on the board. */
export const BOARD_STATUSES: TaskStatus[] = ['todo', 'in_progress', 'waiting', 'blocked', 'done']
/** The Done column shows at most this many, the latest first. */
export const MAX_DONE = 30
const DAY_MS = 86_400_000

/** Only the tasks finished in the last `days` days in Done, and a link to all of them. */
export interface DoneWindow {
  days: number
  allTo: string
}

/** The cards of a column: by their place, or for Done the latest finished first. */
export function boardColumn(tasks: Task[], status: TaskStatus, done?: DoneWindow, now = Date.now()): Task[] {
  const own = tasks.filter((t) => t.status === status)
  if (status !== 'done') return own.sort((a, b) => a.sort_order - b.sort_order)
  const since = done ? now - done.days * DAY_MS : -Infinity
  return own
    .filter((t) => !done || (t.completed_at !== null && Date.parse(t.completed_at) >= since))
    .sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''))
    .slice(0, MAX_DONE)
}

/**
 * The order to save for a column after a move: every task of that status (`all`), the
 * ones the board doesn't show keeping their places (see mergeIntoFull). Past `limit`
 * tasks (what the server takes at once) only the order shown is sent.
 */
export function columnOrder(all: Task[], status: TaskStatus, shown: string[], id: string, limit = 500): string[] {
  const full = all.filter((t) => t.status === status && t.id !== id).sort((a, b) => a.sort_order - b.sort_order).map((t) => t.id)
  const merged = mergeIntoFull(full, shown, id)
  return merged.length <= limit ? merged : shown
}

/** Every task a board shows, over all its columns (no cancelled ones, Done within its window). */
export function onBoard(tasks: Task[], done?: DoneWindow, now = Date.now()): Task[] {
  return BOARD_STATUSES.flatMap((status) => boardColumn(tasks, status, done, now))
}
