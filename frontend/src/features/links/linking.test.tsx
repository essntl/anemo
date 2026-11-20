import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { propertyChanges, valuesFor } from '@/features/properties/api'
import { hubGroups } from '@/features/documents/hub'
import { bracketsTyped, insertLink, markdownLink } from './brackets'

const link = (type: string, title: string, extra: Record<string, unknown> = {}) => ({
  type, id: `${type}-${title}`, ref: `/${type}/${title}`, title, detail: '', state: 'live', origin: 'explicit',
  created_by_actor: null, created_at: '2026-11-21T10:00:00Z', ...extra,
})
const removeMutate = vi.fn()
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  useLinks: () => ({
    data: {
      links: { document: [link('document', 'Brief')], task: [link('task', 'Old', { state: 'in_trash', origin: 'inline' })], event: [], chat: [] },
      backlinks: { document: [], task: [], event: [link('event', 'Meeting')], chat: [] },
    },
  }),
  useAddLinks: () => ({ mutate: vi.fn() }),
  useRemoveLink: () => ({ mutate: removeMutate }),
}))

const { LinksPanel } = await import('./LinksPanel')

describe('typing [[', () => {
  it('is noticed only when the second bracket was just typed', () => {
    expect(bracketsTyped('See [', 'See [[', 6)).toBe(4)
    expect(bracketsTyped('See [[', 'See [[x', 7)).toBe(-1)
    expect(bracketsTyped('x[', 'x[[', 3)).toBe(1)
    expect(bracketsTyped('[[', '[[', 2)).toBe(-1) // nothing typed
  })

  it('puts an ordinary Markdown link where the brackets were', () => {
    const link = markdownLink('Brief [v2]', '/documents/1')
    expect(link).toBe('[Brief v2](/documents/1)')
    expect(insertLink('See [[ now', 4, link)).toEqual({ text: 'See [Brief v2](/documents/1) now', cursor: 28 })
  })
})

describe('property values of tasks and events', () => {
  it('sends what changed, and null for what was taken away', () => {
    expect(propertyChanges({ client: 'a', type: 'plan' }, { client: 'b', status: 'active' })).toEqual({
      client: 'b', status: 'active', type: null,
    })
    expect(propertyChanges({ tags: ['a'] }, { tags: ['a'] })).toEqual({})
  })

  it('keeps only the values the item can have', () => {
    const def = (key: string, applies_to: string[], project_ids: string[] | null = null) =>
      ({ key, applies_to, project_ids }) as never
    const defs = [def('client', ['document', 'task'], ['p1']), def('type', ['document'])]
    expect(valuesFor(defs, { client: 'x', type: 'brief' }, 'p1', 'task')).toEqual({ client: 'x' })
    expect(valuesFor(defs, { client: 'x' }, null, 'task')).toEqual({})
  })
})

describe('hub pages', () => {
  it('group what has the value by type', () => {
    const row = (type: string, title: string) => ({ type, id: title, title, url: '', properties: {}, updated_at: '' }) as never
    const groups = hubGroups([row('event', 'Meeting'), row('document', 'Brief'), row('task', 'Prototype')])
    expect(groups.map((g) => [g.type, g.rows.length])).toEqual([['document', 1], ['task', 1], ['event', 1]])
  })
})

describe('the links panel', () => {
  it('shows links by type, dead ones as such, and what links here', () => {
    render(<MemoryRouter><LinksPanel type="task" id="t1" editable /></MemoryRouter>)
    expect(screen.getByRole('link', { name: /Brief/ })).toBeTruthy()
    expect(screen.getByText('in the trash')).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Linked from' }).textContent).toContain('Meeting')
    // Explicit links can be removed; one written in the text can't (it has no button).
    fireEvent.click(screen.getByRole('button', { name: 'Remove the link to Brief' }))
    expect(removeMutate).toHaveBeenCalledWith('/document/Brief', expect.anything())
    expect(screen.queryByRole('button', { name: 'Remove the link to Old' })).toBeNull()
  })
})

describe('[[ in the rich editor', () => {
  const type = (editor: import('@tiptap/core').Editor, text: string) => {
    const { from, to } = editor.state.selection
    const handled = editor.view.someProp('handleTextInput', (f) => f(editor.view, from, to, text, () => editor.state.tr))
    if (!handled) editor.commands.insertContent(text)
  }

  it('opens the picker in text, not in code', async () => {
    const { Editor } = await import('@tiptap/core')
    const { editorExtensions } = await import('@/features/documents/editorExtensions')
    const { bracketInput } = await import('@/features/documents/bracketInput')
    const open = vi.fn()
    const editor = new Editor({ extensions: editorExtensions, content: '<p>See </p>', editorProps: { handleTextInput: bracketInput(open) } })
    editor.commands.focus('end')
    type(editor, '[')
    type(editor, '[')
    expect(open).toHaveBeenCalledTimes(1)
    expect(editor.getText()).not.toContain('[') // the brackets went

    open.mockClear()
    editor.commands.setContent('<pre><code>x</code></pre>')
    editor.commands.setTextSelection(2) // after the x, in the code block
    type(editor, '[')
    type(editor, '[')
    expect(open).not.toHaveBeenCalled()
    expect(editor.getText()).toContain('[[')

    editor.commands.setContent('<p><code>ab</code></p>')
    editor.commands.setTextSelection(2) // inside the inline code, between a and b
    type(editor, '[')
    type(editor, '[')
    expect(open).not.toHaveBeenCalled()
    expect(editor.getText()).toBe('a[[b')
    editor.destroy()
  })
})

describe('dead links and values that go', () => {
  it('say how an item is gone', async () => {
    const { linkState, droppedLabels } = await import('./linkTypes')
    expect(linkState({ state: 'in_trash', type: 'task' })).toBe('in the trash')
    expect(linkState({ state: 'deleted', type: 'task' })).toBe('deleted for good')
    expect(linkState({ state: 'deleted', type: 'document' })).toBe('removed')
    expect(linkState({ state: 'live', type: 'document' })).toBeNull()
    expect(droppedLabels({ client: 'x', status: 'a', tags: ['t'] }, [{ key: 'status' }], [{ key: 'client', label: 'Client' }])).toEqual(['Client'])
  })
})
