import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const revision = (id: string, author: string, current = false) => ({ id, author, current, updated_at: '2026-11-10T10:00:00Z' })
let revisions = [revision('r2', 'agent', true), revision('r1', 'user')]
const restore = vi.fn()
vi.mock('../api', () => ({
  useRevisions: () => ({ data: revisions }),
  useRestoreRevision: () => ({ mutate: restore, isPending: false }),
}))
const confirm = vi.fn(async (_options: unknown) => true)
vi.mock('@/components/ui/dialogs', () => ({ confirmDialog: (options: unknown) => confirm(options) }))

const { AgentEditBar } = await import('./AgentEditBar')

beforeEach(() => {
  localStorage.clear()
  restore.mockClear()
  revisions = [revision('r2', 'agent', true), revision('r1', 'user')]
})

describe('the bar over a document an agent edited', () => {
  it('shows while the latest version is the agent’s, and opens the history', async () => {
    const onReview = vi.fn()
    render(<AgentEditBar documentId="d1" onReview={onReview} />)
    expect(screen.getByRole('status')).toHaveTextContent('An agent edited this document')
    await userEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(onReview).toHaveBeenCalled()
  })

  it('is not shown when you wrote the latest version', () => {
    revisions = [revision('r2', 'user', true), revision('r1', 'agent')]
    render(<AgentEditBar documentId="d1" onReview={vi.fn()} />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('Keep hides it for that version, also on the next visit', async () => {
    const first = render(<AgentEditBar documentId="d1" onReview={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Keep' }))
    expect(screen.queryByRole('status')).toBeNull()
    first.unmount()
    render(<AgentEditBar documentId="d1" onReview={vi.fn()} />)
    expect(screen.queryByRole('status')).toBeNull()
    // Another edit by an agent brings it back.
    revisions = [revision('r3', 'agent', true), ...revisions.map((r) => ({ ...r, current: false }))]
    render(<AgentEditBar documentId="d1" onReview={vi.fn()} />)
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('Undo goes back to the version before, after asking', async () => {
    render(<AgentEditBar documentId="d1" onReview={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(confirm).toHaveBeenCalled()
    expect(restore).toHaveBeenCalledWith('r1', expect.anything())
  })

  it('offers no Undo when there is no earlier version', () => {
    revisions = [revision('r1', 'agent', true)]
    render(<AgentEditBar documentId="d1" onReview={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })
})
