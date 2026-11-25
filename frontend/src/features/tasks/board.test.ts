import { describe, expect, it } from 'vitest'
import type { Task } from './api'
import { reorderedTasks } from './api'
import { boardColumn, columnOrder } from './board'

const task = (id: string, more: Partial<Task> = {}) =>
  ({ id, title: id, status: 'todo', sort_order: 0, completed_at: null, project_id: null, tags: [], ...more }) as Task
const NOW = Date.parse('2026-11-25T12:00:00Z')
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString()

describe('the columns of the status board', () => {
  it('puts open tasks in their order', () => {
    const tasks = [task('b', { sort_order: 2 }), task('a', { sort_order: 1 }), task('w', { status: 'waiting' })]
    expect(boardColumn(tasks, 'todo').map((t) => t.id)).toEqual(['a', 'b'])
    expect(boardColumn(tasks, 'waiting').map((t) => t.id)).toEqual(['w'])
  })

  it('shows in Done the latest first, only the last seven days with a window', () => {
    const tasks = [
      task('old', { status: 'done', completed_at: daysAgo(8) }),
      task('new', { status: 'done', completed_at: daysAgo(0.1) }),
      task('mid', { status: 'done', completed_at: daysAgo(6.9) }),
    ]
    expect(boardColumn(tasks, 'done').map((t) => t.id)).toEqual(['new', 'mid', 'old'])
    expect(boardColumn(tasks, 'done', { days: 7, allTo: '/tasks' }, NOW).map((t) => t.id)).toEqual(['new', 'mid'])
  })
})

describe('the order saved after a move', () => {
  it('is the whole column, with the tasks the filters hide kept in place', () => {
    // Bug: only the cards shown were sent, so the hidden ones ended up in any order among them.
    const all = [task('a', { sort_order: 1 }), task('hidden', { sort_order: 2 }), task('b', { sort_order: 3 }), task('x', { status: 'waiting' })]
    expect(columnOrder(all, 'todo', ['x', 'a', 'b'], 'x')).toEqual(['x', 'a', 'hidden', 'b'])
  })

  it('is only what the board shows past what the server takes at once', () => {
    const all = [task('a', { sort_order: 1 }), task('b', { sort_order: 2 }), task('c', { sort_order: 3 })]
    expect(columnOrder(all, 'todo', ['c', 'a'], 'c', 2)).toEqual(['c', 'a'])
  })
})

describe('a move shown before the server answers', () => {
  it('numbers the column and moves the task to its status', () => {
    const tasks = [task('a', { sort_order: 5 }), task('b', { status: 'in_progress' }), task('c', { sort_order: 9 })]
    const out = reorderedTasks(tasks, 'done', ['b'], '2026-11-25T12:00:00Z')
    expect(out.find((t) => t.id === 'b')).toMatchObject({ status: 'done', sort_order: 1, completed_at: '2026-11-25T12:00:00Z' })
    const back = reorderedTasks(out, 'todo', ['c', 'b', 'a'])
    expect(back.map((t) => [t.id, t.status, t.sort_order, t.completed_at])).toEqual([['a', 'todo', 3, null], ['b', 'todo', 2, null], ['c', 'todo', 1, null]])
  })
})
