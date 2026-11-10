import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  items: [] as Record<string, unknown>[],
  restore: vi.fn(),
  purge: vi.fn(),
  kinds: [] as string[],
}))
vi.mock('./api', () => ({
  useTrashed: (kind: string) => {
    state.kinds.push(kind)
    return { data: state.items, isError: false, error: null }
  },
  useRestoreTrashed: () => ({ mutate: state.restore, isPending: false, isError: false, error: null }),
  usePurgeTrashed: () => ({ mutate: state.purge, isPending: false, isError: false, error: null }),
}))

const { ItemTrashDialog } = await import('./ItemTrashDialog')

const item = (over: Record<string, unknown>) => ({
  id: 't1', kind: 'task', item_id: 'a', title: 'Write the report', deleted_by: 'user', deleted_at: '2026-11-10T08:00:00Z', ...over,
})

describe('the trash of tasks and events', () => {
  beforeEach(() => {
    state.items = []
    state.kinds = []
    state.restore.mockReset()
    state.purge.mockReset()
  })

  it('says so when it is empty', () => {
    render(<ItemTrashDialog kind="event" open onOpenChange={() => {}} />)
    expect(screen.getByText('Deleted events')).toBeInTheDocument()
    expect(screen.getByText('The trash is empty.')).toBeInTheDocument()
    expect(state.kinds).toContain('event')
  })

  it('lists what was deleted, says when an agent did it, and restores', async () => {
    state.items = [item({}), item({ id: 't2', title: 'Old idea', deleted_by: 'agent' })]
    render(<ItemTrashDialog kind="task" open onOpenChange={() => {}} />)
    expect(screen.getByText('Write the report')).toBeInTheDocument()
    expect(screen.getAllByText(/by an agent/)).toHaveLength(1)
    await userEvent.click(screen.getAllByRole('button', { name: 'Restore' })[1])
    expect(state.restore.mock.calls[0][0]).toBe('t2')
  })

  it('asks before deleting for good', async () => {
    state.items = [item({})]
    render(<ItemTrashDialog kind="task" open onOpenChange={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: 'Delete “Write the report” forever' }))
    expect(state.purge).not.toHaveBeenCalled() // a confirmation comes first
  })
})
