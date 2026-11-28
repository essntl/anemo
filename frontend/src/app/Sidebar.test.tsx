import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePalette } from '@/features/search/paletteStore'

// The parts of the sidebar this test is not about.
vi.mock('@/features/auth/api', () => ({ useMe: () => ({ data: { username: 'admin' } }), useLogout: () => ({ mutate: vi.fn() }) }))
vi.mock('@/features/profile/profile', () => ({ useProfile: () => ({ data: { display_name: 'Artem' } }) }))
vi.mock('@/features/profile/Avatar', () => ({ Avatar: () => null }))
vi.mock('@/features/chat/components/ConversationList', () => ({ ConversationList: () => null }))
vi.mock('@/features/views/ViewLinks', () => ({ ViewLinks: () => null }))
vi.mock('@/features/plugins/slots', () => ({ PluginLinks: () => null }))
vi.mock('./ScopeControl', () => ({ ScopeControl: () => null }))
vi.mock('./PagesFolder', () => ({ PagesFolder: () => null }))
vi.mock('./badges', () => ({ InboxBadge: () => null }))
vi.mock('./pageList', () => ({ usePages: () => ({ pinned: [], more: [] }) }))

const { Sidebar, SidebarRail } = await import('./Sidebar')
const show = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>)

beforeEach(() => usePalette.setState({ open: false }))

describe('search in the sidebar', () => {
  it('is a small button right before Hide the sidebar, with the shortcut in its tooltip', async () => {
    show(<Sidebar />)
    expect(screen.queryByText('Search or jump to…')).toBeNull() // the wide field is gone
    const search = screen.getByRole('button', { name: 'Search' })
    expect(search).toHaveAttribute('title', 'Search (Ctrl+K)')
    expect(search.nextElementSibling).toBe(screen.getByRole('button', { name: 'Hide the sidebar' }))
    expect(search.className).toBe(screen.getByRole('button', { name: 'Hide the sidebar' }).className)
    await userEvent.click(search)
    expect(usePalette.getState().open).toBe(true)
  })

  it('on a phone sits in the menu header, and closes the menu before the search opens', async () => {
    const close = vi.fn()
    show(<Sidebar onClose={close} />)
    const header = screen.getByRole('button', { name: 'Close menu' }).parentElement!
    await userEvent.click(within(header).getByRole('button', { name: 'Search' }))
    expect(close).toHaveBeenCalled()
    expect(usePalette.getState().open).toBe(true)
  })

  it('the folded sidebar keeps its search button', async () => {
    show(<SidebarRail />)
    const search = screen.getByRole('button', { name: 'Search' })
    expect(search).toHaveAttribute('title', 'Search (Ctrl+K)')
    await userEvent.click(search)
    expect(usePalette.getState().open).toBe(true)
  })
})
