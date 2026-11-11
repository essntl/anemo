import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { projectsKey, type Project } from '@/features/tasks/api'
import { useProjectStore } from './projectStore'
import { ScopeControl } from './ScopeControl'

const project = (id: string, name: string, archived = false) => ({ id, name, color: '#1f9d6b', archived }) as Project

function show(projects: Project[] = [project('p1', 'Thesis'), project('p2', 'Old', true)], variant: 'field' | 'inline' = 'field') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(projectsKey, projects)
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ScopeControl variant={variant} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** Opens the choices and returns the menu. */
async function openMenu() {
  await userEvent.click(screen.getByRole('button', { name: /^Showing / }))
  return screen.getByRole('menu', { name: 'Show' })
}

beforeEach(() => {
  localStorage.clear()
  useProjectStore.setState({ projectId: null, view: 'uncategorized' })
})

describe('ScopeControl', () => {
  it('starts on Uncategorized, and says so on the button', async () => {
    show()
    expect(screen.getByRole('button', { name: 'Showing Uncategorized' })).toBeInTheDocument()
    const menu = await openMenu()
    expect(within(menu).getByRole('menuitemradio', { name: 'Uncategorized' })).toHaveAttribute('aria-checked', 'true')
    expect(within(menu).getByRole('menuitemradio', { name: 'All' })).toHaveAttribute('aria-checked', 'false')
  })

  it('All shows everything, and Uncategorized goes back', async () => {
    show()
    await userEvent.click(within(await openMenu()).getByRole('menuitemradio', { name: 'All' }))
    expect(useProjectStore.getState()).toMatchObject({ projectId: null, view: 'all' })
    // Choosing closes the list, and the button names the choice.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Showing All' })).toBeInTheDocument()
    await userEvent.click(within(await openMenu()).getByRole('menuitemradio', { name: 'Uncategorized' }))
    expect(useProjectStore.getState()).toMatchObject({ projectId: null, view: 'uncategorized' })
  })

  it('lists the projects that are not archived, and chooses one', async () => {
    show()
    const menu = await openMenu()
    expect(within(menu).getAllByRole('menuitemradio').map((el) => el.getAttribute('aria-label'))).toEqual(['Uncategorized', 'All', 'Thesis'])
    await userEvent.click(within(menu).getByRole('menuitemradio', { name: 'Thesis' }))
    expect(useProjectStore.getState().projectId).toBe('p1')
    // The button now names the project, and the list marks it.
    expect(screen.getByRole('button', { name: 'Showing Thesis' })).toBeInTheDocument()
    const again = await openMenu()
    expect(within(again).getByRole('menuitemradio', { name: 'Thesis' })).toHaveAttribute('aria-checked', 'true')
    expect(within(again).getByRole('menuitemradio', { name: 'Uncategorized' })).toHaveAttribute('aria-checked', 'false')
  })

  it('leaving a project with All forgets it', async () => {
    useProjectStore.setState({ projectId: 'p1' })
    show()
    await userEvent.click(within(await openMenu()).getByRole('menuitemradio', { name: 'All' }))
    expect(useProjectStore.getState()).toMatchObject({ projectId: null, view: 'all' })
  })

  it('a project that was archived or deleted falls back to the view chosen last', () => {
    useProjectStore.setState({ projectId: 'p2', view: 'all' })
    show()
    expect(screen.getByRole('button', { name: 'Showing All' })).toBeInTheDocument()
  })

  it('without projects the list offers to create one', async () => {
    show([])
    const menu = await openMenu()
    expect(within(menu).getByRole('menuitem', { name: 'Create a project…' })).toBeInTheDocument()
    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(2)
  })

  it('the line under a phone page title offers the same choices', async () => {
    show(undefined, 'inline')
    await userEvent.click(within(await openMenu()).getByRole('menuitemradio', { name: 'Thesis' }))
    expect(useProjectStore.getState().projectId).toBe('p1')
    expect(screen.getByRole('button', { name: 'Showing Thesis' })).toBeInTheDocument()
  })
})
