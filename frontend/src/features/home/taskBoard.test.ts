import { describe, expect, it } from 'vitest'
import type { Project, Task } from '@/features/tasks/api'
import { filterTasks, lanesOf, readFilters, writeFilters } from './taskBoard'

const task = (id: string, more: Partial<Task> = {}) => ({ id, status: 'todo', due_date: null, project_id: null, tags: [], ...more }) as Task
const project = { id: 'p1', name: 'House' } as Project
const TODAY = '2026-11-25'
const all = { kind: 'all' } as const
const ids = (tasks: Task[]) => tasks.map((t) => t.id)

describe('the Home board filters', () => {
  it('are kept in the widget options and read back, unknown values falling back', () => {
    const f = { project: '', tag: 'errands', due: 'week', lanes: true } as const
    expect(readFilters(writeFilters(f))).toEqual(f)
    expect(readFilters(undefined)).toEqual({ project: null, tag: '', due: 'all', lanes: false })
    expect(readFilters({ due: 'someday' }).due).toBe('all')
  })

  it('filter by when a task is due', () => {
    const tasks = [
      task('late', { due_date: '2026-11-20' }),
      task('late-done', { due_date: '2026-11-20', status: 'done' }),
      task('week', { due_date: '2026-12-02' }),
      task('later', { due_date: '2026-12-03' }),
      task('none'),
    ]
    const f = readFilters({})
    expect(ids(filterTasks(tasks, { ...f, due: 'overdue' }, all, TODAY))).toEqual(['late'])
    expect(ids(filterTasks(tasks, { ...f, due: 'week' }, all, TODAY))).toEqual(['late', 'late-done', 'week'])
    expect(filterTasks(tasks, f, all, TODAY)).toHaveLength(5)
  })

  it('follow the project switcher until a project is chosen here, and filter by tag', () => {
    const tasks = [task('a', { project_id: 'p1', tags: ['x'] }), task('b'), task('c', { project_id: 'p1' })]
    const f = readFilters({})
    expect(ids(filterTasks(tasks, f, { kind: 'uncategorized' }, TODAY))).toEqual(['b'])
    expect(ids(filterTasks(tasks, { ...f, project: '' }, { kind: 'uncategorized' }, TODAY))).toEqual(['a', 'b', 'c'])
    expect(ids(filterTasks(tasks, f, { kind: 'project', project: project }, TODAY))).toEqual(['a', 'c'])
    expect(ids(filterTasks(tasks, { ...f, tag: 'x' }, all, TODAY))).toEqual(['a'])
  })

  it('make lanes per project, those in none last, empty ones left out', () => {
    const lanes = lanesOf([task('a'), task('b', { project_id: 'p1' })], [project, { id: 'p2' } as Project])
    expect(lanes.map((l) => [l.id, ids(l.tasks)])).toEqual([['p1', ['b']], ['', ['a']]])
  })
})
