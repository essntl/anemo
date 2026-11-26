import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '@/app/projectStore'
import type { Project, Task } from '@/features/tasks/api'
import { addDays, today } from '@/features/tasks/dates'
import type { WidgetLayout } from '../layout'

/* Home's task board widget: the status board with its filters, kept in the widget's options. */
const server = vi.hoisted(() => ({ tasks: [] as unknown[], projects: [] as unknown[] }))
vi.mock('@/api/client', () => ({
  api: { GET: async (path: string) => ({ data: path === '/api/projects' ? server.projects : server.tasks }) },
  unwrap: (r: { data: unknown }) => r.data,
  errorMessage: String,
}))

const { TaskBoardWidget } = await import('./TaskBoardWidget')

const task = (id: string, more: Partial<Task> = {}): Task =>
  ({
    id, title: `Task ${id}`, description: '', status: 'todo', priority: 0, sort_order: 0, due_date: null, due_time: null,
    remind_minutes: null, rrule: null, tags: [], project_id: null, parent_id: null, blocked_by: [], checklist: [],
    completed_at: null, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', ...more,
  }) as unknown as Task
const project = (id: string, name: string) => ({ id, name, color: '#3b82f6', archived: false, slug: id }) as unknown as Project
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()

function show(options: Record<string, string | null> = {}) {
  const onOptions = vi.fn()
  const item: WidgetLayout = { id: 'board', w: 3, h: 2, options }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}><MemoryRouter><TaskBoardWidget item={item} onOptions={onOptions} /></MemoryRouter></QueryClientProvider>,
  )
  return onOptions
}
const cards = (column: string) =>
  within(screen.getAllByRole('region', { name: column })[0]).queryAllByRole('button').map((b) => b.querySelector('span.min-w-0')?.textContent).filter(Boolean)

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {}
})

beforeEach(() => {
  useProjectStore.setState({ projectId: null, view: 'all' })
  server.projects = [project('p1', 'House'), project('p2', 'Work')]
  server.tasks = [
    task('late', { due_date: addDays(today(), -2), project_id: 'p1', tags: ['errands'] }),
    task('soon', { due_date: addDays(today(), 3), status: 'in_progress', project_id: 'p2' }),
    task('someday', { status: 'waiting' }),
    task('recent', { status: 'done', completed_at: daysAgo(2), project_id: 'p1' }),
    task('long-ago', { status: 'done', completed_at: daysAgo(30) }),
  ]
})

describe('the task board widget', () => {
  it('shows the board, with only the last seven days in Done and a link to all of them', async () => {
    show()
    expect(await screen.findByText('Task late')).toBeInTheDocument()
    expect(cards('Done')).toEqual(['Task recent'])
    expect(within(screen.getByRole('region', { name: 'Done' })).getByRole('link', { name: 'Show all' })).toHaveAttribute('href', '/tasks')
    expect(screen.getByText('3 open')).toBeInTheDocument()
  })

  it('opens with the filters it was left with', async () => {
    show({ due: 'overdue' })
    expect(await screen.findByText('Task late')).toBeInTheDocument()
    expect(screen.queryByText('Task soon')).toBeNull()
    expect(screen.queryByText('Task someday')).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Due' })).toHaveTextContent('Overdue')
  })

  it('keeps a filter that is chosen', async () => {
    const onOptions = show()
    await screen.findByText('Task late')
    screen.getByRole('combobox', { name: 'Due' }).focus()
    await userEvent.keyboard('{Enter}')
    await userEvent.click(await screen.findByRole('option', { name: 'Due this week' }))
    expect(onOptions).toHaveBeenCalledWith({ project: null, tag: null, due: 'week', lanes: null })
  })

  it('shows a lane per project, the tasks in none last', async () => {
    show({ lanes: 'project' })
    await screen.findByText('Task late')
    const lanes = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)
    expect(lanes).toEqual(['House 2', 'Work 1', 'No project 1'])
    expect(screen.getByRole('group', { name: 'House: tasks by status' })).toBeInTheDocument()
  })

  it('follows a project chosen here', async () => {
    show({ project: 'p2' })
    expect(await screen.findByText('Task soon')).toBeInTheDocument()
    expect(screen.queryByText('Task late')).toBeNull()
  })
})
