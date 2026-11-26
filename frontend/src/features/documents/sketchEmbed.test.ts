import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { editorExtensions } from './editorExtensions'
import { imagesToEditor, imagesToFile, tidyMarkdown } from './markdown'

const ID = '0193a2b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b'
const FILE = `Before\n\n![Kitchen plan](/documents/${ID})\n`

describe('a sketch embedded in a document', () => {
  it('is shown by its image in the editor and written back as the sketch’s address', () => {
    const inEditor = imagesToEditor(FILE, 'documents/notes/a.md')
    expect(inEditor).toContain(`![Kitchen plan](/api/documents/${ID}/sketch/preview)`)
    expect(imagesToFile(inEditor, 'documents/notes/a.md')).toBe(FILE)
  })

  it('keeps other images as they were', () => {
    const file = '![photo](../_assets/p.png)\n![web](https://example.com/x.png)\n'
    expect(imagesToFile(imagesToEditor(file, 'documents/notes/a.md'), 'documents/notes/a.md')).toBe(file)
  })

  it('in the rich editor, shows the image with a link that opens the sketch, and keeps the text', () => {
    const editor = new Editor({ extensions: editorExtensions, content: imagesToEditor(FILE, 'documents/a.md'), contentType: 'markdown' })
    const img = editor.view.dom.querySelector('img')
    expect(img?.getAttribute('src')).toBe(`/api/documents/${ID}/sketch/preview`)
    expect(editor.view.dom.querySelector('.sketch-embed a')?.getAttribute('href')).toBe(`/documents/${ID}`)
    expect(imagesToFile(tidyMarkdown(editor.getMarkdown()), 'documents/a.md')).toBe(FILE)
    editor.destroy()
  })

  it('in the rich editor, shows the sketch’s name when it has no image yet', () => {
    const editor = new Editor({ extensions: editorExtensions, content: imagesToEditor(FILE, 'documents/a.md'), contentType: 'markdown' })
    editor.view.dom.querySelector('img')?.dispatchEvent(new Event('error'))
    expect(editor.view.dom.querySelector('img')).toBeNull()
    expect(editor.view.dom.querySelector('.sketch-embed')?.textContent).toContain('Kitchen plan')
    editor.destroy()
  })
})
