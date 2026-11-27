import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { listRows } from '../listRows'

// jsdom lays nothing out: give the list a window's height, so the rows in sight are drawn.
beforeAll(() => {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(50) // each row
})

const doc = (id: string, title: string, folder: string, kind = 'markdown') => ({
  id, title, folder, kind, path: `documents/${folder ? `${folder}/` : ''}${id}.md`, updated_at: '2026-11-10T10:00:00Z', word_count: 10, last_editor: 'user',
})
const documents = [doc('a', 'Shopping list', ''), doc('b', 'Chapter 3', 'thesis'), doc('c', 'Meeting notes', 'thesis/meetings'), doc('d', 'Recipes', 'cooking')]
const mutate = vi.hoisted(() => vi.fn())
vi.mock('../api', () => ({
  useDocuments: () => ({ data: { documents, folders: [] }, isSuccess: true, error: null }),
  useCreateDocument: () => ({ mutate, isPending: false, error: null }),
  usePrefetchDocument: () => () => undefined,
}))

const { DocumentList } = await import('./DocumentList')
const titles = () => screen.getAllByRole('link').map((el) => el.textContent?.replace(/Nov.*$/, '').trim())
const show = (props: Partial<Parameters<typeof DocumentList>[0]>, address = '/documents') =>
  render(<MemoryRouter initialEntries={[address]}><DocumentList currentFolder="" {...props} /></MemoryRouter>)

describe('the list of documents', () => {
  it('draws only the rows in sight of a long list, folders before their documents', () => {
    const many = Array.from({ length: 6000 }, (_, i) => doc(`n${i}`, `Note ${i}`, i % 2 ? 'odd' : ''))
    const rows = listRows(many as never) // the fixtures leave out what the list does not show
    expect(rows).toHaveLength(6001) // one folder heading
    expect(rows[0]).toMatchObject({ kind: 'doc', key: 'n0' })
    expect(rows[3000]).toMatchObject({ kind: 'folder', folder: 'odd' })

    documents.push(...many)
    try {
      show({})
      const links = screen.getAllByRole('link')
      expect(links.length).toBeGreaterThan(5)
      expect(links.length).toBeLessThan(60) // not 6004
    } finally {
      documents.splice(4)
    }
  })

  it('All lists every document', () => {
    show({})
    expect(screen.getAllByRole('link')).toHaveLength(4)
  })

  it('a project lists its folder and the folders in it', () => {
    show({ projectFolder: 'thesis', projectName: 'Thesis' })
    expect(titles().join(' ')).toMatch(/Chapter 3.*Meeting notes/)
    expect(screen.getAllByRole('link')).toHaveLength(2)
    expect(screen.getByText('Thesis')).toBeInTheDocument()
  })

  it('Uncategorized leaves out what is in a project’s folder, and keeps other folders', () => {
    show({ outside: ['thesis'] })
    expect(screen.getAllByRole('link')).toHaveLength(2)
    expect(screen.getByText('Shopping list')).toBeInTheDocument()
    expect(screen.getByText('Recipes')).toBeInTheDocument()
    expect(screen.queryByText('Chapter 3')).toBeNull()
    expect(screen.queryByText('Meeting notes')).toBeNull()
    expect(screen.getByText('Uncategorized')).toBeInTheDocument()
  })
})

describe('a new sketch', () => {
  it('is made with its title and kind of sheet, in the folder being looked at', async () => {
    mutate.mockClear()
    show({ currentFolder: 'thesis' })
    await userEvent.click(screen.getByRole('button', { name: 'New sketch' }))
    const dialog = screen.getByRole('dialog', { name: 'New sketch' })
    await userEvent.type(within(dialog).getByRole('textbox'), 'Kitchen plan')
    await userEvent.click(within(dialog).getByRole('radio', { name: 'A4 pages' }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }))
    expect(mutate).toHaveBeenCalledWith({ title: 'Kitchen plan', folder: 'thesis', kind: 'sketch', layout: 'pages' }, expect.anything())
  })

  it('is asked for by the address (the command palette)', () => {
    show({}, '/documents?new=sketch')
    expect(screen.getByRole('dialog', { name: 'New sketch' })).toBeInTheDocument()
  })

  it('is listed with the documents, as a drawing', () => {
    documents.push(doc('e', 'Whiteboard', '', 'sketch'))
    show({})
    expect(screen.getByRole('link', { name: /Whiteboard/ })).toHaveTextContent('Drawing sheet')
    documents.pop()
  })
})
