import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Task } from '../api'

/* The status board of the Tasks page and Home, against a mocked API. */
const server = vi.hoisted(() => ({
  tasks: [] as unknown[],
  posts: [] as { path: string; body: unknown }[],
  answer: null as null | (() => Promise<{ data?: unknown; error?: unknown }>),
}))
vi.mock('@/api/client', () => ({
  api: {
    GET: async () => ({ data: structuredClone(server.tasks) }),
    POST: async (path: string, init: { body: unknown }) => {
      server.posts.push({ path, body: init.body })
      return server.answer ? server.answer() : { data: null }
    },
  },
  unwrap: (r: { data?: unknown; error?: unknown }) => {
    if (r.error) throw new Error(String(r.error))
    return r.data
  },
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}))
const toasts = vi.hoisted(() => [] as string[])
vi.mock('@/components/ui/toast', () => ({ toast: (o: { message: string }) => toasts.push(o.message) }))

const { useTasks } = await import('../api')
const { byId } = await import('../relations')
const { TaskBoard } = await import('./TaskBoard')

const task = (id: string, more: Partial<Task> = {}): Task =>
  ({
    id, title: `Task ${id}`, description: '', status: 'todo', priority: 0, sort_order: 0, due_date: null, due_time: null,
    remind_minutes: null, rrule: null, tags: [], project_id: null, parent_id: null, blocked_by: [], checklist: [],
    completed_at: null, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', ...more,
  }) as unknown as Task

/** The board as a page shows it: every task from the query, the `shown` ones on the board. */
function Page({ shown }: { shown?: (t: Task) => boolean }) {
  const tasks = useTasks()
  const all = tasks.data ?? []
  return (
    <TaskBoard tasks={all.filter(shown ?? (() => true))} info={{ all, byId: byId(all) }} projects={new Map()}
      onOpen={() => {}} onAdd={() => {}} />
  )
}

function renderBoard(shown?: (t: Task) => boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><MemoryRouter><Page shown={shown} /></MemoryRouter></QueryClientProvider>)
}

const column = (name: string) => screen.getByRole('region', { name })
const titles = (name: string) => within(column(name)).queryAllByRole('button').map((b) => b.querySelector('span.min-w-0')?.textContent).filter(Boolean)
const cardEl = (title: string) => screen.getByText(title).closest<HTMLElement>('[data-board-card]')!
/** Picks a card up with the keyboard, presses the arrows, and puts it down. */
function moveWithKeys(title: string, keys: string[]) {
  const el = cardEl(title)
  fireEvent.keyDown(el, { key: ' ' })
  for (const key of keys) fireEvent.keyDown(el, { key })
  fireEvent.keyDown(el, { key: ' ' })
}

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {}
})

beforeEach(() => {
  server.posts = []
  server.answer = null
  toasts.length = 0
  server.tasks = [
    task('a', { sort_order: 1 }),
    task('hidden', { sort_order: 2, tags: ['other'] }),
    task('b', { sort_order: 3 }),
    task('c', { status: 'in_progress', sort_order: 1 }),
    task('w', { status: 'waiting' }),
    task('x', { status: 'cancelled' }),
    task('d', { status: 'done', completed_at: '2026-11-20T00:00:00Z' }),
  ]
})

describe('the task board', () => {
  it('has a column per status, in order, without cancelled tasks', async () => {
    renderBoard()
    await screen.findByText('Task a')
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['To do', 'In progress', 'Waiting', 'Blocked', 'Done'])
    expect(titles('To do')).toEqual(['Task a', 'Task hidden', 'Task b'])
    expect(titles('Done')).toEqual(['Task d'])
    expect(screen.queryByText('Task x')).toBeNull()
  })

  it('moves a card to another status at once, and saves the whole column', async () => {
    server.answer = () => new Promise(() => {}) // the server hasn't answered yet
    renderBoard()
    await screen.findByText('Task a')
    moveWithKeys('Task a', ['ArrowRight', 'ArrowDown'])
    await waitFor(() => expect(titles('In progress')).toEqual(['Task c', 'Task a']))
    expect(titles('To do')).toEqual(['Task hidden', 'Task b'])
    expect(server.posts).toEqual([{ path: '/api/tasks/reorder', body: { status: 'in_progress', ordered_ids: ['c', 'a'], subtasks: null } }])
  })

  it('keeps the place of tasks a filter hides when reordering', async () => {
    renderBoard((t) => !t.tags.includes('other'))
    await screen.findByText('Task a')
    expect(titles('To do')).toEqual(['Task a', 'Task b'])
    moveWithKeys('Task b', ['ArrowUp'])
    await waitFor(() => expect(server.posts).toHaveLength(1))
    expect(server.posts[0].body).toEqual({ status: 'todo', ordered_ids: ['b', 'a', 'hidden'], subtasks: null })
  })

  it('sends only the task that goes to Done', async () => {
    renderBoard()
    await screen.findByText('Task a')
    moveWithKeys('Task w', ['ArrowRight', 'ArrowRight'])
    await waitFor(() => expect(server.posts).toHaveLength(1))
    expect(server.posts[0].body).toEqual({ status: 'done', ordered_ids: ['w'], subtasks: null })
  })

  it('puts the card back and says why when the server refuses', async () => {
    let refuse: (r: { error: string }) => void = () => {}
    server.answer = () => new Promise((resolve) => { refuse = resolve })
    renderBoard()
    await screen.findByText('Task a')
    moveWithKeys('Task a', ['ArrowRight'])
    await waitFor(() => expect(titles('In progress')).toEqual(['Task a', 'Task c']))
    refuse({ error: 'Not allowed' })
    await waitFor(() => expect(titles('To do')).toEqual(['Task a', 'Task hidden', 'Task b']))
    expect(titles('In progress')).toEqual(['Task c'])
    expect(toasts).toEqual(['Not allowed'])
  })
})
