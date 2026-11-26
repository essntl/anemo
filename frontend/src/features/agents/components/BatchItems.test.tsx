import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolCallView } from '../api'

const asked: string[][] = []
let failing = false
vi.mock('@/features/links/api', () => ({
  useLinkTargets: (refs: string[]) => {
    asked.push(refs)
    if (failing) return { data: undefined, isError: true }
    return {
      isError: false,
      data: refs.map((ref) => {
        const id = ref.split('=')[1]
        if (id === 'gone') return { type: 'task', id, ref, title: '', detail: '', state: 'deleted' }
        if (id === 'binned') return { type: 'task', id, ref, title: 'Binned', detail: '', state: 'in_trash' }
        return { type: 'task', id, ref, title: `Task ${id}`, detail: 'todo', state: 'live' }
      }),
    }
  },
}))
vi.mock('../api', () => ({
  useDecide: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useTimeline: () => ({ data: undefined }),
}))

const { ApprovalCard } = await import('./ApprovalCard')
const { batchItems } = await import('../batch')

function batchCall(items: { id: string; item: string; risk?: string }[], summary: string): ToolCallView {
  return {
    id: 'c1',
    step: 0,
    position: 0,
    tool_name: 'update_tasks',
    capability: 'tasks.write',
    args: {},
    actions: [
      { capability: 'tasks.write', summary, risk: 'safe' },
      ...items.map((i) => ({ capability: 'tasks.write', summary: '', item: i.item, ref: `/tasks?task=${i.id}`, risk: i.risk ?? 'safe' })),
    ],
    risk: items.some((i) => i.risk === 'dangerous') ? 'dangerous' : 'safe',
    decision: 'ask',
    decision_reason: 'tasks.write: ask',
    status: 'waiting_approval',
    result: null,
    result_data: null,
    is_error: false,
    started_at: null,
    ended_at: null,
    approval: { id: 'a1', kind: 'action', status: 'pending', summary },
  } as unknown as ToolCallView
}

function renderCard(call: ToolCallView) {
  return render(<MemoryRouter><ApprovalCard runId="r1" call={call} /></MemoryRouter>)
}

describe('the approval of a batch', () => {
  beforeEach(() => {
    asked.length = 0
    failing = false
  })

  it('sums up 30 items in one line and lists them all on request', async () => {
    const user = userEvent.setup()
    const items = Array.from({ length: 30 }, (_, n) => ({ id: String(n), item: 'due → Fri 2026-11-27' }))
    renderCard(batchCall(items, 'Change 30 tasks: due → Fri 2026-11-27'))

    expect(screen.getByText('The agent wants to: Change 30 tasks: due → Fri 2026-11-27')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Items in this batch' })).not.toBeInTheDocument()
    expect(asked.every((refs) => refs.length === 0)).toBe(true) // no titles fetched while folded

    await user.click(screen.getByRole('button', { name: 'Show all 30 items' }))
    const list = screen.getByRole('list', { name: 'Items in this batch' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(30)
    expect(within(list).getByRole('link', { name: 'Task 0' })).toHaveAttribute('href', '/tasks?task=0')
    expect(within(list).getAllByText('due → Fri 2026-11-27')).toHaveLength(30)
    expect(asked.at(-1)).toHaveLength(30)

    await user.click(screen.getByRole('button', { name: 'Hide the items' }))
    expect(screen.queryByRole('list', { name: 'Items in this batch' })).not.toBeInTheDocument()
    // One approval for the whole batch: the usual three buttons, once.
    expect(screen.getAllByRole('button', { name: 'Allow once' })).toHaveLength(1)
  })

  it('lists a short batch at once, saying which items are gone or in the trash', () => {
    renderCard(
      batchCall(
        [
          { id: '1', item: 'status → done' },
          { id: 'binned', item: 'move to the trash', risk: 'dangerous' },
          { id: 'gone', item: 'status → done' },
        ],
        'Change 2 tasks: status → done, move 1 to the trash',
      ),
    )
    const list = screen.getByRole('list', { name: 'Items in this batch' })
    expect(within(list).getByRole('link', { name: 'Task 1' })).toBeInTheDocument()
    expect(within(list).getByRole('link', { name: /^Binned\s*\(in the trash\)$/ })).toBeInTheDocument()
    expect(within(list).getByText('not found')).toBeInTheDocument()
    expect(within(list).getByText('move to the trash')).toHaveClass('text-error')
    expect(screen.queryByRole('button', { name: /Show/ })).not.toBeInTheDocument()
  })

  it('shows the references when the titles cannot be loaded', () => {
    failing = true
    renderCard(batchCall([{ id: '7', item: 'priority → high' }], 'Change 1 task: priority → high'))
    expect(screen.getByRole('link', { name: '/tasks?task=7' })).toBeInTheDocument()
  })

  it('finds no items in an ordinary call', () => {
    expect(batchItems({ actions: [{ capability: 'tasks.write', summary: 'Change a task' }] })).toEqual([])
    renderCard({ ...batchCall([], 'Change a task'), tool_name: 'update_task' })
    expect(screen.queryByRole('list', { name: 'Items in this batch' })).not.toBeInTheDocument()
  })
})
