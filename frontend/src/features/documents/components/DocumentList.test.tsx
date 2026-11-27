import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { changedBucket, listRows } from '../listRows'
import { useDocListStore } from '../docListStore'

// jsdom lays nothing out: give the list a window's height, so the rows in sight are drawn.
beforeAll(() => {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(50) // each row
  // jsdom has no matchMedia (the row menu asks it for the phone layout): a desktop.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('min-width'), media: query, addEventListener: () => {}, removeEventListener: () => {},
  }))
})

type Props = Record<string, unknown>
const doc = (id: string, title: string, folder: string, kind = 'markdown', properties: Props = {}, updated_at = '2026-11-10T10:00:00Z') => ({
  id, title, folder, kind, properties, path: `documents/${folder ? `${folder}/` : ''}${id}.md`, updated_at, word_count: 10, last_editor: 'user',
})
const documents = [doc('a', 'Shopping list', ''), doc('b', 'Chapter 3', 'thesis'), doc('c', 'Meeting notes', 'thesis/meetings'), doc('d', 'Recipes', 'cooking')]
const mocks = vi.hoisted(() => ({ mutate: vi.fn(), archive: vi.fn(), toggle: vi.fn(), pinned: [] as string[] }))
vi.mock('../api', () => ({
  useDocuments: () => ({ data: { documents, folders: [] }, isSuccess: true, error: null }),
  useCreateDocument: () => ({ mutate: mocks.mutate, isPending: false, error: null }),
  usePrefetchDocument: () => () => undefined,
  useArchiveDocument: () => ({ mutate: mocks.archive }),
}))
vi.mock('../usePins', () => ({
  useDocumentPins: () => ({ projectId: null, ids: mocks.pinned, isPinned: (id: string) => mocks.pinned.includes(id), toggle: mocks.toggle }),
}))
const option = (slug: string, label: string) => ({ slug, label })
vi.mock('@/features/properties/api', () => ({
  useProperties: () => ({
    data: [
      { key: 'type', type: 'select', options: [option('plan', 'Plan'), option('prompt', 'Prompt')] },
      { key: 'status', type: 'select', options: [option('draft', 'Draft'), option('active', 'Active'), option('archived', 'Archived')] },
    ],
  }),
  valueLabel: (d: { options: { slug: string; label: string }[] } | undefined, v: unknown) => d?.options.find((o) => o.slug === v)?.label ?? String(v),
}))

const { DocumentList } = await import('./DocumentList')
const titles = () => screen.getAllByRole('link').map((el) => el.getAttribute('title'))
const show = (props: Partial<Parameters<typeof DocumentList>[0]>, address = '/documents') =>
  render(<MemoryRouter initialEntries={[address]}><DocumentList currentFolder="" {...props} /></MemoryRouter>)

beforeEach(() => {
  useDocListStore.setState({ views: {} })
  mocks.pinned = []
})

describe('the list of documents', () => {
  it('draws only the rows in sight of a long list, folders before their documents', () => {
    const many = Array.from({ length: 6000 }, (_, i) => doc(`n${i}`, `Note ${i}`, i % 2 ? 'odd' : ''))
    const rows = listRows(many as never) // the fixtures leave out what the list does not show
    expect(rows).toHaveLength(6001) // one folder heading
    expect(rows[0]).toMatchObject({ kind: 'doc', key: 'n0' })
    expect(rows[3000]).toMatchObject({ kind: 'group', label: 'odd', count: 3000 })

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

  it('Uncategorized with no project folders lists everything, top level included', () => {
    show({ outside: [] })
    expect(screen.getAllByRole('link')).toHaveLength(4)
    expect(screen.getByText('Shopping list')).toBeInTheDocument()
  })
})

describe('groups', () => {
  const D = (id: string, properties: Props = {}, updated_at?: string, title = id) => doc(id, title, '', 'markdown', properties, updated_at) as never
  const types = [option('plan', 'Plan'), option('prompt', 'Prompt')]
  const labels = (rows: ReturnType<typeof listRows>) => rows.map((r) => (r.kind === 'group' ? `[${r.label} ${r.count}]` : r.doc.id)).join(' ')

  it('by type: in the order of the values, documents without one last', () => {
    const docs = [D('x'), D('p1', { type: 'prompt' }), D('l1', { type: 'plan' }), D('o1', { type: 'odd' })]
    expect(labels(listRows(docs, { groupBy: 'type', types }))).toBe('[Plan 1] l1 [Prompt 1] p1 [odd 1] o1 [No type 1] x')
  })

  it('by status, with archived and done folded into Archived at the bottom', () => {
    const docs = [D('a', { status: 'active' }), D('z', { status: 'archived' }), D('y', { status: 'done' }), D('n')]
    const rows = listRows(docs, { groupBy: 'status', statuses: [option('active', 'Active')] })
    expect(labels(rows)).toBe('[Active 1] a [No status 1] n [Archived 2]')
    expect(labels(listRows(docs, { groupBy: 'status', folded: { archived: false } }))).toMatch(/\[Archived 2\] y z$/)
    expect(labels(listRows(docs, { groupBy: 'status', hideArchived: true }))).not.toMatch(/Archived/)
  })

  it('by last change, and sorted newest first', () => {
    const now = new Date(2026, 10, 27, 15, 0)
    const at = (days: number) => new Date(2026, 10, 27 - days, 12).toISOString()
    expect(['today', 'week', 'month', 'older'].map((_, i) => changedBucket(at([0, 3, 20, 90][i]), now))).toEqual(['today', 'week', 'month', 'older'])
    const docs = [D('old', {}, at(90)), D('new', {}, at(0)), D('mid', {}, at(3)), D('mid2', {}, at(2))]
    expect(labels(listRows(docs, { groupBy: 'changed', sortBy: 'changed', now }))).toBe('[Today 1] new [This week 2] mid2 mid [Older 1] old')
  })

  it('pinned documents come first whatever the grouping, folded groups keep their count', () => {
    const docs = [D('a', { type: 'plan' }), D('b', { type: 'plan' }), D('c', { status: 'archived' })]
    const rows = listRows(docs, { groupBy: 'type', types, pinned: ['b', 'c'], folded: { 'type:plan': true } })
    expect(labels(rows)).toBe('[Pinned 2] b c [Plan 1]')
    expect(labels(listRows(docs, { groupBy: 'type', types, folded: { 'type:plan': true }, openAll: true }))).toMatch(/\[Plan 2\] a b/)
  })

  it('fades the start of a title other documents in the group share', () => {
    const docs = [D('1', {}, undefined, 'Prompt: Anemo agent – fix the list'), D('2', {}, undefined, 'Prompt: Anemo agent – tidy up'), D('3', {}, undefined, 'Prompt: write a poem'), D('4', {}, undefined, 'Shopping')]
    const prefixes = Object.fromEntries(listRows(docs).flatMap((r) => (r.kind === 'doc' ? [[r.doc.id, r.prefix]] : [])))
    expect(prefixes).toEqual({ 1: 'Prompt: Anemo agent – '.length, 2: 'Prompt: Anemo agent – '.length, 3: 'Prompt: '.length, 4: 0 })
  })

  it('a heading folds its group, and the choice is remembered', async () => {
    show({})
    const heading = screen.getByRole('button', { name: /cooking\s*1/ })
    expect(heading).toHaveAttribute('aria-expanded', 'true')
    await userEvent.click(heading)
    expect(screen.queryByText('Recipes')).toBeNull()
    expect(useDocListStore.getState().views.outside.folded).toEqual({ 'folder:cooking': true })
  })

  it('the search finds documents in folded groups too', async () => {
    useDocListStore.getState().fold('outside', 'folder:cooking', true)
    show({})
    expect(screen.queryByText('Recipes')).toBeNull()
    await userEvent.type(screen.getByRole('textbox', { name: 'Find by title' }), 'reci')
    expect(screen.getByText('Recipes')).toBeInTheDocument()
  })

  it('the row shows the status and type, and the arrow keys move between rows', async () => {
    documents.push(doc('e', 'Launch plan', '', 'markdown', { type: 'plan', status: 'draft' }) as never)
    try {
      show({})
      const row = screen.getByRole('link', { name: /Launch plan/ })
      expect(row).toHaveTextContent('Draft')
      expect(row).toHaveTextContent('Plan')
      row.focus()
      await userEvent.keyboard('{ArrowDown}')
      expect(document.activeElement).toHaveAttribute('title', 'Shopping list')
    } finally {
      documents.pop()
    }
  })
})

describe('the toolbar and the meta line', () => {
  it('has Group by, Sort, the archive switch and Tidy up on one toolbar, with short labels', async () => {
    documents.push(doc('z', 'Old prompt', '', 'markdown', { status: 'archived' }) as never)
    try {
      show({})
      const toolbar = screen.getByRole('group', { name: 'List view' })
      const group = within(toolbar).getByRole('combobox', { name: 'Group by' })
      expect(group).toHaveTextContent('Folder')
      expect(group).toHaveAttribute('title', 'Group by folder')
      expect(within(toolbar).getByRole('combobox', { name: 'Sort' })).toHaveTextContent('Title')
      expect(within(toolbar).getByRole('button', { name: 'Hide archived documents' })).toBeInTheDocument()
      expect(within(toolbar).getByRole('button', { name: 'Tidy up' })).toBeEnabled()
      useDocListStore.getState().change('outside', { groupBy: 'changed', sortBy: 'changed' })
      expect(await within(toolbar).findByText('Last change')).toBeInTheDocument()
      expect(within(toolbar).getByRole('combobox', { name: 'Sort' })).toHaveTextContent('Recent')
    } finally {
      documents.pop()
    }
  })

  it('puts chips, the agent mark and the age on one line in that order, also without chips', () => {
    documents.push(
      { ...doc('e', 'Launch plan', '', 'markdown', { type: 'plan', status: 'active' }), last_editor: 'agent' } as never,
      { ...doc('f', 'Queue', '', 'markdown'), last_editor: 'agent' } as never,
    )
    try {
      show({})
      for (const [title, expected] of [['Launch plan', ['Active', 'Plan', 'agent', 'age']], ['Queue', ['agent', 'age']]] as const) {
        const time = screen.getByRole('link', { name: new RegExp(title) }).querySelector('time')!
        const line = [...time.parentElement!.children].flatMap((el) =>
          el.tagName === 'TIME' ? ['age'] : el.getAttribute('aria-label') === 'Last changed by an agent' ? ['agent'] : [...el.children].map((c) => c.textContent))
        expect(line).toEqual(expected)
      }
    } finally {
      documents.splice(4)
    }
  })
})

describe('the row menu', () => {
  it('pins and archives', async () => {
    show({})
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Recipes' }))
    await userEvent.click(screen.getByRole('button', { name: 'Pin to the top' }))
    expect(mocks.toggle).toHaveBeenCalledWith('d')
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Recipes' }))
    await userEvent.click(screen.getByRole('button', { name: 'Archive' }))
    expect(mocks.archive).toHaveBeenCalledWith({ id: 'd', archived: true }, expect.anything())
  })

  it('opens on right-click, and offers to unarchive an archived document', async () => {
    documents.push(doc('z', 'Old prompt', '', 'markdown', { status: 'archived' }) as never)
    useDocListStore.getState().fold('outside', 'archived', false)
    try {
      show({})
      expect(screen.getByRole('button', { name: /Archived\s*1/ })).toBeInTheDocument()
      const row = screen.getByRole('link', { name: /Old prompt/ })
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
      await userEvent.click(await screen.findByRole('button', { name: 'Unarchive' }))
      expect(mocks.archive).toHaveBeenCalledWith({ id: 'z', archived: false }, expect.anything())
    } finally {
      documents.pop()
    }
  })

  it('the archived group can be hidden', async () => {
    documents.push(doc('z', 'Old prompt', '', 'markdown', { status: 'archived' }) as never)
    try {
      show({})
      expect(screen.getByRole('button', { name: /Archived\s*1/ })).toHaveAttribute('aria-expanded', 'false')
      await userEvent.click(screen.getByRole('button', { name: 'Hide archived documents' }))
      expect(screen.queryByRole('button', { name: /Archived\s*1/ })).toBeNull()
    } finally {
      documents.pop()
    }
  })
})

describe('a new sketch', () => {
  it('is made with its title and kind of sheet, in the folder being looked at', async () => {
    mocks.mutate.mockClear()
    show({ currentFolder: 'thesis' })
    await userEvent.click(screen.getByRole('button', { name: 'New sketch' }))
    const dialog = screen.getByRole('dialog', { name: 'New sketch' })
    await userEvent.type(within(dialog).getByRole('textbox'), 'Kitchen plan')
    await userEvent.click(within(dialog).getByRole('radio', { name: 'A4 pages' }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }))
    expect(mocks.mutate).toHaveBeenCalledWith({ title: 'Kitchen plan', folder: 'thesis', kind: 'sketch', layout: 'pages' }, expect.anything())
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
