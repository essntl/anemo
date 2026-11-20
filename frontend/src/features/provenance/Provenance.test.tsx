import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'

const confirm = vi.fn(async (_options: unknown) => true)
vi.mock('@/components/ui/dialogs', () => ({ confirmDialog: (options: unknown) => confirm(options) }))

const { ActorLine, SourceBadge, SourceDetails } = await import('./Provenance')
const { actorLabel } = await import('./labels')

const chat = { ref: 'chat:c1', kind: 'chat' as const, label: 'Ludmyla planning', url: '/c/c1' }
const user = { ref: 'user', kind: 'user' as const, label: 'You', url: null }
const run = { ref: 'automation:a1/r1', kind: 'automation' as const, label: 'Artemk sync', url: '/automations?automation=a1&run=r1' }

const inRouter = (node: ReactNode) => render(<MemoryRouter>{node}</MemoryRouter>)

describe('who made something', () => {
  it('names the chat it was made in, with a link to it, and who changed it last', () => {
    inRouter(<ActorLine created={chat} updated={user} />)
    expect(screen.getByText(/Created by the assistant in/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Ludmyla planning' }).getAttribute('href')).toBe('/c/c1')
    expect(screen.getByText(/Last changed by you\./)).toBeTruthy()
  })

  it('says so when you made it, and only once when nobody else changed it', () => {
    inRouter(<ActorLine created={user} updated={user} />)
    expect(screen.getByText('Created by you.')).toBeTruthy()
    expect(screen.queryByText(/Last changed/)).toBeNull()
  })

  it('links an automation to its run, and a deleted chat to nothing', () => {
    inRouter(<ActorLine created={run} updated={{ ...chat, label: 'deleted chat', url: null }} />)
    expect(screen.getByRole('link', { name: 'Artemk sync' }).getAttribute('href')).toBe('/automations?automation=a1&run=r1')
    expect(screen.getByText(/Last changed by the assistant in a chat that was deleted\./)).toBeTruthy()
  })

  it('shows nothing when it is not known', () => {
    const { container } = inRouter(<ActorLine created={null} updated={null} />)
    expect(container.textContent).toBe('')
  })

  it('has short names for the history of a document', () => {
    expect(actorLabel(chat)).toBe('Assistant in “Ludmyla planning”')
    expect(actorLabel(run)).toBe('Automation “Artemk sync”')
    expect(actorLabel({ ...run, url: null })).toBe('A deleted automation')
    expect(actorLabel({ ref: 'external', kind: 'external', label: 'Outside Anemo', url: null })).toBe('Outside the app')
    expect(actorLabel(user)).toBe('You')
  })
})

describe('the source badge', () => {
  it('links a synced item to its original, in a new tab', () => {
    render(<SourceBadge item={{ source: 'artemk', external_key: 'artemk:booking:123', source_url: 'https://artemk.example/b/123' }} />)
    const link = screen.getByRole('link')
    expect(link.getAttribute('href')).toBe('https://artemk.example/b/123')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
    expect(link.textContent).toContain('artemk')
  })

  it('is plain text without a link, and absent on ordinary items', () => {
    const { container, rerender } = render(<SourceBadge item={{ source: 'artemk' }} />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(container.textContent).toBe('artemk')
    rerender(<SourceBadge item={{ source: null, external_key: null }} />)
    expect(container.textContent).toBe('')
  })

  it('detaches an item from its source after asking', async () => {
    const onDetach = vi.fn()
    render(<SourceDetails item={{ source: 'artemk', external_key: 'k1', edited_by_user_at: '2026-11-20T10:00:00Z' }} onDetach={onDetach} />)
    expect(screen.getByText('k1')).toBeTruthy()
    expect(screen.getByText(/You changed it by hand/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Detach from source' }))
    expect(confirm).toHaveBeenCalledOnce()
    expect(onDetach).toHaveBeenCalledOnce()
  })
})
