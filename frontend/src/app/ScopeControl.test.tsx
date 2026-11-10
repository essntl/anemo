import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { projectsKey, type Project } from '@/features/tasks/api'
import { useProjectStore } from './projectStore'
import { ScopeControl } from './ScopeControl'

const project = (id: string, name: string, archived = false) => ({ id, name, color: '#1f9d6b', archived }) as Project

function show(projects: Project[] = [project('p1', 'Thesis'), project('p2', 'Old', true)]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(projectsKey, projects)
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ScopeControl />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
  useProjectStore.setState({ projectId: null, view: 'uncategorized' })
})

describe('ScopeControl', () => {
  it('starts on Uncategorized', () => {
    show()
    expect(screen.getByRole('button', { name: 'Uncategorized' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Project' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('All shows everything, and Uncategorized goes back', async () => {
    show()
    await userEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(useProjectStore.getState()).toMatchObject({ projectId: null, view: 'all' })
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'Uncategorized' }))
    expect(useProjectStore.getState()).toMatchObject({ projectId: null, view: 'uncategorized' })
  })

  it('the middle part lists the projects that are not archived, and chooses one', async () => {
    show()
    await userEvent.click(screen.getByRole('button', { name: 'Project' }))
    const menu = screen.getByRole('menu', { name: 'Projects' })
    expect(within(menu).getAllByRole('menuitemradio').map((el) => el.textContent)).toEqual(['Thesis'])
    await userEvent.click(within(menu).getByRole('menuitemradio', { name: 'Thesis' }))
    expect(useProjectStore.getState().projectId).toBe('p1')
    // The control now names the project; the other two parts are off.
    expect(screen.getByRole('button', { name: 'Project: Thesis' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Uncategorized' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('leaving a project with All forgets it', async () => {
    useProjectStore.setState({ projectId: 'p1' })
    show()
    await userEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(useProjectStore.getState()).toMatchObject({ projectId: null, view: 'all' })
  })

  it('a project that was archived or deleted falls back to the view chosen last', () => {
    useProjectStore.setState({ projectId: 'p2', view: 'all' })
    show()
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Project' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('without projects the list offers to create one', async () => {
    show([])
    await userEvent.click(screen.getByRole('button', { name: 'Project' }))
    expect(screen.getByRole('menuitem', { name: 'Create a project…' })).toBeInTheDocument()
  })
})
