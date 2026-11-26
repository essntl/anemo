import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivityEntry } from './api'

const calls = vi.hoisted(() => ({
  gets: [] as Record<string, unknown>[],
  posts: [] as { path: string; params: { path: Record<string, string>; query: { force: boolean } } }[],
  items: [] as unknown[],
  conflict: false,
  groupResults: [{ id: 'a', ok: true, message: 'ok', skipped: false }] as unknown[],
}))

vi.mock('@/api/client', () => {
  class ApiError extends Error {
    readonly code: string
    readonly details: unknown
    constructor(_status: number, code: string, message: string, details?: unknown) {
      super(message)
      this.code = code
      this.details = details
    }
  }
  return {
    ApiError,
    api: {
      GET: async (_path: string, init: { params: { query: Record<string, unknown> } }) => {
        calls.gets.push(init.params.query)
        return { data: { items: calls.items, next_cursor: null } }
      },
      POST: async (path: string, init: { params: { path: Record<string, string>; query: { force: boolean } } }) => {
        calls.posts.push({ path, params: init.params })
        if (calls.conflict && !init.params.query.force) {
          return { error: new ApiError(409, 'activity_conflict', 'It was changed since', { differs: [{ field: 'title' }] }) }
        }
        if (path.includes('groups')) return { data: { results: calls.groupResults } }
        return { data: { message: 'Put back the title of “Buy milk”', entry: calls.items[0] } }
      },
    },
    unwrap: (r: { data?: unknown; error?: unknown }) => {
      if (r.error) throw r.error
      return r.data
    },
    errorMessage: (e: unknown) => String(e),
  }
})

const { ActivityPage } = await import('./ActivityPage')
const { toRows } = await import('./rows')
const { DialogHost } = await import('@/components/ui/DialogHost')
const { useToasts } = await import('@/components/ui/toast')

const actors = {
  user: { ref: 'user', kind: 'user', label: 'You', url: null, automation_kind: null },
  chat: { ref: 'chat:1', kind: 'chat', label: 'Groceries', url: '/c/1', automation_kind: null },
  script: { ref: 'automation:2/3', kind: 'automation', label: 'Tidy', url: '/automations?automation=2&run=3', automation_kind: 'script' },
} as const

function entry(fields: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    actor: actors.user,
    action: 'changed',
    object_type: 'task',
    object_id: 't1',
    object_label: 'Buy milk',
    object_url: '/tasks?task=t1',
    summary: 'Changed the title of the task “Buy milk”',
    fields: ['title'],
    group_id: null,
    group_label: null,
    run_id: null,
    undone_at: null,
    undone_by: null,
    undo_blocked: null,
    ...fields,
  }
}

function show(path = '/activity') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <ActivityPage />
        <DialogHost />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  calls.gets.length = 0
  calls.posts.length = 0
  calls.items = []
  calls.conflict = false
  calls.groupResults = [{ id: 'a', ok: true, message: 'ok', skipped: false }]
  useToasts.setState({ toasts: [] })
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.releasePointerCapture = () => {}
  Element.prototype.scrollIntoView = () => {}
})

describe('the Activity page', () => {
  it('lists who changed what, with Undo where it can be undone', async () => {
    calls.items = [
      entry({ actor: actors.chat }),
      entry({ actor: actors.script, action: 'created', fields: [], object_label: 'Weekly review', undo_blocked: 'not_undoable', object_type: 'project', object_url: '/projects' }),
    ]
    show()
    const [first, second] = await screen.findAllByTestId('activity-entry')
    expect(first).toHaveTextContent('The assistant in Groceries')
    expect(within(first).getByRole('link', { name: 'Groceries' })).toHaveAttribute('href', '/c/1')
    expect(first).toHaveTextContent('Changed task Buy milk: title')
    expect(within(first).getByRole('link', { name: 'Buy milk' })).toHaveAttribute('href', '/tasks?task=t1')
    expect(within(first).getByRole('button', { name: /Undo/ })).toBeEnabled()
    expect(second).toHaveTextContent('Script Tidy')
    expect(second).toHaveTextContent('Created project Weekly review')
    expect(within(second).getByRole('button', { name: /Undo/ })).toBeDisabled()
    expect(within(second).getByTitle('This change can’t be undone')).toBeInTheDocument()
  })

  it('undoes an entry, and asks before overwriting a later change', async () => {
    const changed = entry()
    calls.items = [changed]
    calls.conflict = true
    show()
    await userEvent.click(await screen.findByRole('button', { name: /Undo/ }))
    expect(await screen.findByText('It was changed since. Undo anyway?')).toBeInTheDocument()
    expect(screen.getByText('Changed since: title.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Undo anyway' }))
    await waitFor(() => expect(calls.posts).toHaveLength(2))
    expect(calls.posts[0].params.path).toEqual({ entry_id: changed.id })
    expect(calls.posts.map((p) => p.params.query.force)).toEqual([false, true])
  })

  it('shows a batch as one row that opens, and undoes it together', async () => {
    calls.items = [
      entry({ group_id: 'g1', group_label: 'Moved 2 tasks to Friday', object_label: 'One' }),
      entry({ group_id: 'g1', group_label: 'Moved 2 tasks to Friday', object_label: 'Two' }),
      entry({ object_label: 'Alone' }),
    ]
    show()
    const group = await screen.findByTestId('activity-group')
    expect(group).toHaveTextContent('Moved 2 tasks to Friday')
    expect(group).toHaveTextContent('(2 changes)')
    expect(screen.getAllByTestId('activity-entry')).toHaveLength(1) // the batch is closed
    await userEvent.click(within(group).getByRole('button', { expanded: false }))
    expect(within(group).getAllByTestId('activity-entry')).toHaveLength(2)
    await userEvent.click(within(group).getByRole('button', { name: /Undo all/ }))
    await waitFor(() => expect(calls.posts).toHaveLength(1))
    expect(calls.posts[0].path).toBe('/api/activity/groups/{group_id}/undo')
    expect(calls.posts[0].params.path).toEqual({ group_id: 'g1' })
  })

  it('tells skipped entries of a batch apart from failed ones', async () => {
    calls.items = [entry({ group_id: 'g1', group_label: 'Set up' }), entry({ group_id: 'g1', group_label: 'Set up', undo_blocked: 'not_undoable' })]
    calls.groupResults = [
      { id: 'a', ok: true, message: 'ok', skipped: false },
      { id: 'b', ok: false, message: 'This change can’t be undone', code: 'activity_not_undoable', skipped: true },
    ]
    show()
    const group = await screen.findByTestId('activity-group')
    await userEvent.click(within(group).getByRole('button', { name: /Undo all/ }))
    await waitFor(() => expect(useToasts.getState().toasts.map((x) => x.message)).toEqual(['Undone. 1 change can’t be undone and was skipped']))
  })

  it('shows the history of one item from its address, and can show everything again', async () => {
    show('/activity?object_type=task&object_id=t1')
    await screen.findByText('Nothing here yet')
    expect(calls.gets[0]).toMatchObject({ object_type: 'task', object_id: 't1' })
    await userEvent.click(screen.getByRole('button', { name: 'Show everything' }))
    await waitFor(() => expect(calls.gets.at(-1)).not.toHaveProperty('object_id'))
    expect(calls.gets.at(-1)).toMatchObject({ object_type: 'task' })
  })

  it('filters by who did it', async () => {
    show()
    await screen.findByText('Nothing here yet')
    await userEvent.click(screen.getByRole('combobox', { name: 'Who' }))
    await userEvent.click(await screen.findByRole('option', { name: 'Scripts' }))
    await waitFor(() => expect(calls.gets.at(-1)).toMatchObject({ actor_kind: 'script' }))
  })
})

describe('toRows', () => {
  it('joins neighbours of one batch and leaves a batch of one as an entry', () => {
    const rows = toRows([entry({ group_id: 'a' }), entry({ group_id: 'a' }), entry({ group_id: 'b' }), entry()])
    expect(rows.map((r) => r.kind)).toEqual(['group', 'entry', 'entry'])
  })

  it('keeps a batch in one row when other changes fall between its entries', () => {
    const [a1, other, a2, b, a3] = [entry({ group_id: 'a' }), entry(), entry({ group_id: 'a' }), entry({ group_id: 'b' }), entry({ group_id: 'a' })]
    const rows = toRows([a1, other, a2, b, a3])
    expect(rows.map((r) => (r.kind === 'group' ? r.entries.map((e) => e.id) : r.entry.id))).toEqual([[a1.id, a2.id, a3.id], other.id, b.id])
  })
})
