import { render, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EditorView } from '@uiw/react-codemirror'
import { CodeEditor } from '@/features/files/components/CodeEditor'
import { jumpToHeading } from './jump'
import { outlineOf } from './outline'

const TEXT = '# One\n\ntext\n\n## Two\n\nmore\n\n## Three\n'

describe('jumping to a heading in the Markdown (source) editor', () => {
  it('puts the cursor on the heading’s line, without the page loading CodeMirror itself', async () => {
    const { container } = render(<CodeEditor path="a.md" value={TEXT} onChange={() => undefined} />)
    await waitFor(() => expect(container.querySelector('.cm-editor')).not.toBeNull())
    const outline = outlineOf(TEXT)
    expect(jumpToHeading(container, outline, 2)).toBe(true)
    const view = EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!
    const line = view.state.doc.lineAt(view.state.selection.main.head)
    expect(line.text).toBe('## Three')
  })

  it('without an editor on the page, there is nothing to jump to', () => {
    const root = document.createElement('div')
    expect(jumpToHeading(root, outlineOf(TEXT), 1)).toBe(false)
  })
})
