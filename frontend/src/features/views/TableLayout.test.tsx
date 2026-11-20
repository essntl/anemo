import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import type { PropertyDefinition } from '@/features/properties/api'
import type { SavedView, ViewRow } from './api'
import { TableLayout } from './ViewPage'

const client = {
  key: 'client', label: 'Client', type: 'select',
  options: [{ id: 'o1', slug: 'acme', label: 'Acme' }, { id: 'o2', slug: 'ludmyla-doula', label: 'Ludmyla Doula' }],
} as unknown as PropertyDefinition
const row = (id: string, title: string, properties: Record<string, unknown>) =>
  ({ type: 'document', id, title, url: `/documents/${id}`, properties, updated_at: '2026-11-01T00:00:00Z' }) as ViewRow
const view = { query: { group_by: 'client', columns: ['client'], sort: [] } } as unknown as SavedView

describe('the table layout', () => {
  it('groups the rows by a select property, rows without a value last', () => {
    render(
      <MemoryRouter>
        <TableLayout view={view} definitions={new Map([['client', client]])} onChange={() => {}}
          rows={[row('a', 'Brief', { client: 'ludmyla-doula' }), row('b', 'Offer', { client: 'acme' }), row('c', 'Loose', {})]} />
      </MemoryRouter>,
    )
    const groups = screen.getAllByRole('rowgroup').slice(1) // the header is one too
    expect(groups.map((g) => g.querySelector('th')?.textContent)).toEqual([
      'Acme 1', 'Ludmyla Doula 1', 'No Client 1',
    ])
    expect(within(groups[1]).getByRole('link').textContent).toBe('Brief')
  })
})
