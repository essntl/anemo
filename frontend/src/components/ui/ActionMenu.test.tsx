import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Pencil, Trash2 } from 'lucide-react'
import { ActionMenu } from './ActionMenu'

let desktop = false
vi.mock('@/hooks/useMediaQuery', () => ({ DESKTOP: '(min-width: 768px)', useMediaQuery: () => desktop }))

function menu(onRename = vi.fn()) {
  render(
    <ActionMenu label="Actions for Notes" actions={[
      { label: 'Rename', icon: <Pencil />, onSelect: onRename },
      { label: 'Delete', icon: <Trash2 />, danger: true },
    ]} />,
  )
  return onRename
}

describe('ActionMenu', () => {
  it('on a phone opens as a sheet named after the button, and closes after an action', async () => {
    desktop = false
    const onRename = menu()
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Notes' }))
    const sheet = screen.getByRole('dialog', { name: 'Actions for Notes' })
    expect(sheet).toHaveClass('sheet')
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(onRename).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('on a desktop pops up next to the button and can scroll in a low window', async () => {
    desktop = true
    menu()
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Notes' }))
    expect(screen.queryByRole('dialog', { name: 'Actions for Notes' })).toBeNull()
    const item = screen.getByRole('button', { name: 'Delete' })
    expect(item.parentElement).toHaveClass('pop', 'overflow-y-auto')
  })
})
