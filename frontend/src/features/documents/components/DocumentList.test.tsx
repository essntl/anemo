import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'

const doc = (id: string, title: string, folder: string) => ({
  id, title, folder, path: `documents/${folder ? `${folder}/` : ''}${id}.md`, updated_at: '2026-11-10T10:00:00Z', word_count: 10, last_editor: 'user',
})
const documents = [doc('a', 'Shopping list', ''), doc('b', 'Chapter 3', 'thesis'), doc('c', 'Meeting notes', 'thesis/meetings'), doc('d', 'Recipes', 'cooking')]
vi.mock('../api', () => ({
  useDocuments: () => ({ data: { documents, folders: [] }, isSuccess: true, error: null }),
  useCreateDocument: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}))

const { DocumentList } = await import('./DocumentList')
const titles = () => screen.getAllByRole('link').map((el) => el.textContent?.replace(/Nov.*$/, '').trim())
const show = (props: Partial<Parameters<typeof DocumentList>[0]>) =>
  render(<MemoryRouter><DocumentList currentFolder="" {...props} /></MemoryRouter>)

describe('the list of documents', () => {
  it('All lists every document', () => {
    show({})
    expect(screen.getAllByRole('link')).toHaveLength(4)
  })

  it('a project lists its folder and the folders in it', () => {
    show({ projectFolder: 'thesis', projectName: 'Thesis' })
    expect(titles().join(' ')).toMatch(/Chapter 3.*Meeting notes/)
    expect(screen.getAllByRole('link')).toHaveLength(2)
    expect(screen.getByRole('heading')).toHaveTextContent('Thesis')
  })

  it('Uncategorized leaves out what is in a project’s folder, and keeps other folders', () => {
    show({ outside: ['thesis'] })
    expect(screen.getAllByRole('link')).toHaveLength(2)
    expect(screen.getByText('Shopping list')).toBeInTheDocument()
    expect(screen.getByText('Recipes')).toBeInTheDocument()
    expect(screen.queryByText('Chapter 3')).toBeNull()
    expect(screen.queryByText('Meeting notes')).toBeNull()
    expect(screen.getByRole('heading')).toHaveTextContent('Uncategorized')
  })
})
