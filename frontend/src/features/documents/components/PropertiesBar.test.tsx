import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const option = (id: string, slug: string, label: string) => ({ id, slug, label, hub_document_id: null, sort_order: 0, count: 0 })
const definitions = [
  { id: 'd1', key: 'type', label: 'Type', type: 'select', applies_to: ['document'], project_ids: null, open_vocabulary: false, builtin: true, sort_order: 0, count: 1,
    options: [option('o1', 'brief', 'Brief'), option('o2', 'plan', 'Plan')] },
  { id: 'd2', key: 'client', label: 'Client', type: 'select', applies_to: ['document'], project_ids: ['p1'], open_vocabulary: false, builtin: false, sort_order: 1, count: 0,
    options: [option('o3', 'ludmyla-doula', 'Ludmyla Doula')] },
]
const mutateAsync = vi.fn(async () => ({}))
vi.mock('@/features/properties/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/properties/api')>()),
  useProperties: () => ({ data: definitions }),
}))
vi.mock('../api', () => ({ useSetProperties: () => ({ mutateAsync, isPending: false }) }))

const { PropertiesBar, showsProperties } = await import('./PropertiesBar')
const doc = (over: object) => ({
  id: 'doc', path: 'documents/a.md', folder: '', title: 'A', kind: 'markdown' as const, word_count: 1, last_editor: 'user', updated_at: '2026-11-01T00:00:00Z',
  content: '---\ntype: brief\n---\n# A\n', hash: 'h1', properties: { type: 'brief' }, properties_error: null, ...over,
})

describe('the properties above a document', () => {
  it('belong above the text only when there is something to show (a phone offers "+ Property" below it)', () => {
    expect(showsProperties(doc({}) as never)).toBe(true)
    expect(showsProperties(doc({ properties: {} }) as never)).toBe(false)
    expect(showsProperties(doc({ properties: {}, properties_error: 'broken YAML' }) as never)).toBe(true)
  })

  it('draws its line on the side that faces the text', () => {
    const { container, rerender } = render(<PropertiesBar doc={doc({})} projectId={null} baseHash={() => 'h1'} flush={async () => true} />)
    expect(container.firstElementChild).toHaveClass('border-b')
    rerender(<PropertiesBar doc={doc({})} projectId={null} baseHash={() => 'h1'} flush={async () => true} edge="bottom" />)
    expect(container.firstElementChild).toHaveClass('border-t')
  })

  it('shows each value by its label and changes it through the server', async () => {
    const flush = vi.fn(async () => true)
    render(<PropertiesBar doc={doc({})} projectId={null} baseHash={() => 'h1'} flush={flush} />)
    fireEvent.click(screen.getByRole('button', { name: /Type:\s*Brief/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Plan' }))
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ set: { type: 'plan' }, baseHash: 'h1' }))
    expect(flush).toHaveBeenCalled()
  })

  it('offers only the properties of the project the document is in', () => {
    const { rerender } = render(<PropertiesBar doc={doc({ properties: {} })} projectId={null} baseHash={() => 'h1'} flush={async () => true} />)
    fireEvent.click(screen.getByRole('button', { name: /Property/ }))
    expect(screen.queryByRole('button', { name: 'Client' })).toBeNull()
    rerender(<PropertiesBar doc={doc({ properties: {} })} projectId="p1" baseHash={() => 'h1'} flush={async () => true} />)
    expect(screen.getByRole('button', { name: 'Client' })).toBeInTheDocument()
  })

  it('warns when the front matter can not be read, instead of showing properties', () => {
    render(<PropertiesBar doc={doc({ properties: {}, properties_error: 'The properties block is not valid YAML (line 2).' })}
      projectId={null} baseHash={() => 'h1'} flush={async () => true} />)
    expect(screen.getByRole('status')).toHaveTextContent('not valid YAML (line 2)')
    expect(screen.queryByRole('button', { name: /Property/ })).toBeNull()
  })
})
