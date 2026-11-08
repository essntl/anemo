import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/* frontend-7: only "not logged in" leads to the login page. */
const me = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
vi.mock('./api', () => ({ meKey: ['me'], useMe: () => me.value }))

const { RequireAuth } = await import('./RequireAuth')

function renderAt(path: string) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<RequireAuth />}>
            <Route path="/tasks" element={<p>The tasks page</p>} />
          </Route>
          <Route path="/login" element={<p>The login page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('the login check', () => {
  beforeEach(() => {
    me.value = {}
  })

  it('shows the page to a logged-in user', () => {
    me.value = { isPending: false, isError: false, data: { username: 'admin' }, refetch: vi.fn() }
    renderAt('/tasks')
    expect(screen.getByText('The tasks page')).toBeInTheDocument()
  })

  it('sends someone who is not logged in to the login page', () => {
    me.value = { isPending: false, isError: false, data: null, refetch: vi.fn() }
    renderAt('/tasks')
    expect(screen.getByText('The login page')).toBeInTheDocument()
  })

  it('says the server can’t be reached instead of asking to log in again', () => {
    me.value = { isPending: false, isError: true, isFetching: false, data: undefined, error: new Error('Server error'), refetch: vi.fn() }
    renderAt('/tasks')
    expect(screen.getByText('Can’t reach Anemo')).toBeInTheDocument()
    expect(screen.queryByText('The login page')).toBeNull()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})
