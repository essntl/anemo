import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const count = vi.hoisted(() => ({ decisions: 0, unread: 0 }))
vi.mock('@/features/notifications/useInboxCount', () => ({ useInboxCount: () => count }))

const { InboxBadge } = await import('./badges')

describe('the Inbox badge', () => {
  it('shows what needs a decision, in amber, before unread notifications', () => {
    Object.assign(count, { decisions: 2, unread: 5 })
    render(<InboxBadge />)
    const badge = screen.getByTitle('2 need you, 5 unread')
    expect(badge).toHaveTextContent('2')
    expect(badge).toHaveClass('bg-warning')
  })

  it('shows the unread count in the accent colour when nothing needs a decision', () => {
    Object.assign(count, { decisions: 0, unread: 3 })
    render(<InboxBadge />)
    const badge = screen.getByTitle('3 unread')
    expect(badge).toHaveTextContent('3')
    expect(badge).toHaveClass('bg-accent')
  })

  it('is not shown when there is nothing', () => {
    Object.assign(count, { decisions: 0, unread: 0 })
    const { container } = render(<InboxBadge />)
    expect(container).toBeEmptyDOMElement()
  })
})
