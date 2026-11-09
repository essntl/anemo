import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as RadixDialog from '@radix-ui/react-dialog'
import { CheckSquare, FolderOpen, House } from 'lucide-react'
import { MemoryRouter } from 'react-router'
import { useMobileNav } from './mobileNavStore'
import { PagesFolder, type PageEntry } from './PagesFolder'

beforeEach(() => useMobileNav.setState({ open: true, pagesOpen: false }))


const pages: PageEntry[] = [
  { to: '/home', icon: <House />, label: 'Home' },
  { to: '/files', icon: <FolderOpen />, label: 'Files', badge: <span>3</span> },
  { to: '/tasks', icon: <CheckSquare />, label: 'Tasks' },
]

/** The folder inside a dialog, as it is inside the phone menu. */
function folder(at: string, onNavigate = vi.fn()) {
  render(
    <MemoryRouter initialEntries={[at]}>
      <RadixDialog.Root open>
        <RadixDialog.Portal>
          <RadixDialog.Content aria-describedby={undefined}>
            <RadixDialog.Title>Menu</RadixDialog.Title>
            <PagesFolder pages={pages} onNavigate={onNavigate} />
          </RadixDialog.Content>
        </RadixDialog.Portal>
      </RadixDialog.Root>
    </MemoryRouter>,
  )
  return onNavigate
}

describe('PagesFolder', () => {
  it('folded, the bar names the page you are on and keeps its counts in sight', () => {
    folder('/tasks/123')
    const bar = screen.getByRole('button', { name: 'Pages, on Tasks' })
    expect(bar).toHaveTextContent('Tasks')
    expect(bar).toHaveTextContent('3')
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('says "Pages" when you are on none of them', () => {
    folder('/c/abc')
    expect(screen.getByRole('button', { name: 'Pages' })).toHaveTextContent('Pages')
  })

  it('opens as a card with every page; Esc folds the card and leaves the menu open', async () => {
    folder('/home')
    await userEvent.click(screen.getByRole('button', { name: /^Pages/ }))
    const card = screen.getByRole('dialog', { name: 'Pages' })
    expect(card.querySelectorAll('a')).toHaveLength(3)
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Pages' })).toBeNull())
    expect(screen.getByRole('dialog', { name: 'Menu' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pages, on Home' })).toBeInTheDocument()
  })

  it('tapping a page folds the card and closes the menu', async () => {
    const onNavigate = folder('/home')
    await userEvent.click(screen.getByRole('button', { name: /^Pages/ }))
    await userEvent.click(screen.getByRole('link', { name: /^Files/ }))
    expect(onNavigate).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pages, on Files' })).toBeInTheDocument())
  })
})
