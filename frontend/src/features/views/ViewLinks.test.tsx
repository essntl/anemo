import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { SavedView } from './api'

const view = (id: string, name: string, project_id: string | null, pinned: boolean, sort_order = 0) =>
  ({ id, name, project_id, pinned, sort_order, layout: 'list', query: {}, updated_at: '' }) as unknown as SavedView
const views = [view('a', 'Legal', 'p1', false, 0), view('b', 'Clients', 'p1', true, 1), view('c', 'Global', null, false)]
vi.mock('./api', () => ({ useViews: () => ({ data: views }) }))
let projectId: string | null = 'p1'
vi.mock('@/app/projectStore', () => ({
  useScope: () => (projectId ? { kind: 'project', project: { id: projectId } } : { kind: 'all' }),
}))

const { ViewLinks } = await import('./ViewLinks')
const { viewsOf } = await import('./query')

describe('views in the sidebar', () => {
  it('lists every view of the project, pinned ones first', () => {
    expect(viewsOf(views, 'p1').map((v) => v.name)).toEqual(['Clients', 'Legal'])
    render(<MemoryRouter><ViewLinks /></MemoryRouter>)
    expect(screen.getAllByRole('link').map((l) => l.textContent)).toEqual(['Clients', 'Legal'])
  })
  it('shows the global views when no project is shown, unpinned ones too', () => {
    projectId = null
    render(<MemoryRouter><ViewLinks /></MemoryRouter>)
    expect(screen.getAllByRole('link').map((l) => l.textContent)).toEqual(['Global'])
  })
})
