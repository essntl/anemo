import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { Scope } from '@/app/projectStore'

const useConversations = vi.fn((_q: string, _filters: unknown) => ({ data: [] }))
vi.mock('../api', () => ({
  useConversations: (q: string, filters: unknown) => useConversations(q, filters),
  useDeleteConversation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))
let scope: Scope = { kind: 'uncategorized' }
vi.mock('@/app/projectStore', () => ({ useScope: () => scope }))

const { ConversationList } = await import('./ConversationList')

function show(next: Scope) {
  scope = next
  useConversations.mockClear()
  render(<MemoryRouter><ConversationList /></MemoryRouter>)
  return useConversations.mock.calls[0][1]
}

describe('the chats in the sidebar', () => {
  it('Uncategorized asks only for chats that are in no project', () => {
    expect(show({ kind: 'uncategorized' })).toEqual({ noProject: true })
    expect(screen.getByText('No chats outside a project yet.')).toBeInTheDocument()
  })

  it('a project asks for its chats', () => {
    const project = { id: 'p1', name: 'Thesis' } as Extract<Scope, { kind: 'project' }>['project']
    expect(show({ kind: 'project', project })).toEqual({ projectId: 'p1' })
    expect(screen.getByText('No chats in Thesis yet.')).toBeInTheDocument()
  })

  it('All asks for every chat', () => {
    expect(show({ kind: 'all' })).toEqual({ noProject: false })
    expect(screen.getByText('No chats yet.')).toBeInTheDocument()
  })
})
