import { describe, expect, it } from 'vitest'
import type { Task } from './api'
import {
  blockerCandidates,
  byId,
  checklistProgress,
  newItem,
  openBlockers,
  openSubtasksLeft,
  parentCandidates,
  subtasksOf,
  waitingOn,
} from './relations'

let n = 0
function task(id: string, extra: Partial<Task> = {}): Task {
  n += 1
  return {
    id, title: id.toUpperCase(), description: '', status: 'todo', priority: 0, due_date: null, due_time: null,
    remind_minutes: null, rrule: null, completed_at: null, tags: [], project_id: null, parent_id: null,
    checklist: [], blocked_by: [], sort_order: 0, created_by: 'user',
    created_at: `2026-11-0${n % 9}T00:00:00Z`, updated_at: '2026-11-01T00:00:00Z',
    ...extra,
  }
}

describe('task relations', () => {
  it('counts ticked checklist items', () => {
    expect(checklistProgress([])).toBeNull()
    const items = [{ ...newItem('a'), done: true }, newItem('b'), newItem('c')]
    expect(checklistProgress(items)).toEqual({ done: 1, total: 3 })
    expect(items[0].id).toMatch(/^[0-9a-f]{8}$/)
    expect(newItem('  x  ').text).toBe('x')
  })

  it('finds what blocks a task and what waits on it', () => {
    const all = [
      task('a'),
      task('b', { status: 'done' }),
      task('c', { blocked_by: ['a', 'b', 'gone'] }),
      task('d', { blocked_by: ['c'] }),
    ]
    const tasks = byId(all)
    expect(openBlockers(tasks.get('c')!, tasks).map((t) => t.id)).toEqual(['a'])
    expect(waitingOn(all, 'c').map((t) => t.id)).toEqual(['d'])
  })

  it('offers no blockers that would make a loop', () => {
    const all = [
      task('a'),
      task('b', { blocked_by: ['a'] }),
      task('c', { blocked_by: ['b'] }),
      task('x', { status: 'cancelled' }),
      task('y', { status: 'done' }),
    ]
    // a may not wait on itself, nor on b or c, which (through b) wait on a.
    expect(blockerCandidates(all, 'a', []).map((t) => t.id)).toEqual(['y'])
    // c may wait on a (already does through b, that's fine) but not twice on b.
    expect(blockerCandidates(all, 'c', ['b']).map((t) => t.id)).toEqual(['a', 'y'])
    // A new task can wait on anything open or done; open ones come first.
    expect(blockerCandidates(all, null, []).map((t) => t.id)).toEqual(['a', 'b', 'c', 'y'])
  })

  it('keeps subtasks one level deep', () => {
    const all = [
      task('p'),
      task('s1', { parent_id: 'p' }),
      task('s2', { parent_id: 'p', status: 'done' }),
      task('q'),
      task('old', { status: 'done' }),
    ]
    expect(subtasksOf(all, 'p').map((t) => t.id)).toEqual(['s1', 's2'])
    // p has subtasks: it can't become one.
    expect(parentCandidates(all, all[0])).toEqual([])
    // A subtask can move to another open top-level task, not under another subtask.
    expect(parentCandidates(all, all[1]).map((t) => t.id)).toEqual(['p', 'q'])
    expect(parentCandidates(all, null).map((t) => t.id)).toEqual(['p', 'q'])
  })

  it('counts the open subtasks a finish would leave behind', () => {
    const all = [
      task('p'),
      task('s1', { parent_id: 'p' }),
      task('s2', { parent_id: 'p' }),
      task('s3', { parent_id: 'p', status: 'done' }),
    ]
    expect(openSubtasksLeft(all, ['p'])).toBe(2)
    expect(openSubtasksLeft(all, ['p', 's1'])).toBe(1)
    expect(openSubtasksLeft(all, ['s1'])).toBe(0)
  })
})
