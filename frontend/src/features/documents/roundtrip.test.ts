import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { editorExtensions } from './editorExtensions'
import {
  imagesToEditor,
  imagesToFile,
  joinFrontMatter,
  needsSourceMode,
  splitFrontMatter,
  tidyMarkdown,
} from './markdown'

/** What the rich editor writes back for a Markdown text. */
function roundTrip(markdown: string): string {
  const editor = new Editor({ extensions: editorExtensions, content: markdown, contentType: 'markdown' })
  const out = tidyMarkdown(editor.getMarkdown())
  editor.destroy()
  return out
}

const SAMPLE = `# Trip plan

Some **bold**, *italic*, ~~struck~~ and \`code\` text with a [link](https://example.org).

## Lists

- one
- two
  - nested

1. first
2. second

- [ ] todo
- [x] done

> A quote

\`\`\`python
print("hi")


print("two blank lines above stay")
\`\`\`

| City   | Days |
| ------ | ---- |
| Lisbon | 3    |

![Photo](/api/files/download?path=documents%2F_assets%2Fphoto.png)

---

The end.
`

describe('rich editor Markdown round trip', () => {
  it('keeps headings, marks, lists, checklists, quotes, code, tables, images and rules', () => {
    expect(roundTrip(SAMPLE)).toBe(SAMPLE)
  })

  it('is stable: a second pass changes nothing', () => {
    const once = roundTrip('* star bullets\n* become dashes\n\n| a | b |\n|---|---|\n| 1 | 2 |\n')
    expect(once).toContain('- star bullets')
    expect(roundTrip(once)).toBe(once)
  })
})

describe('document Markdown helpers', () => {
  it('keeps front matter apart from the body', () => {
    const text = '---\ntitle: Plan\ntags: [a]\n---\n# Plan\n\nBody\n'
    const { frontMatter, body } = splitFrontMatter(text)
    expect(frontMatter).toBe('---\ntitle: Plan\ntags: [a]\n---\n')
    expect(body).toBe('# Plan\n\nBody\n')
    expect(joinFrontMatter(frontMatter, body)).toBe(text)
    expect(splitFrontMatter('# No front matter\n---\nrule')).toEqual({ frontMatter: '', body: '# No front matter\n---\nrule' })
  })

  it('maps image paths between the file and the editor', () => {
    const file = '![a](../_assets/my%20photo.png "Title") and ![b](https://x.example/i.png) ![c](pic.png)'
    const editor = imagesToEditor(file, 'documents/travel/lisbon.md')
    expect(editor).toContain('![a](/api/files/download?path=documents%2F_assets%2Fmy%20photo.png "Title")')
    expect(editor).toContain('![b](https://x.example/i.png)')
    expect(editor).toContain('![c](/api/files/download?path=documents%2Ftravel%2Fpic.png)')
    expect(imagesToFile(editor, 'documents/travel/lisbon.md')).toBe(
      '![a](../_assets/my%20photo.png "Title") and ![b](https://x.example/i.png) ![c](pic.png)',
    )
    // A document at the top level points straight into _assets.
    expect(imagesToFile('![x](/api/files/download?path=documents%2F_assets%2Fx.png)', 'documents/a.md')).toBe(
      '![x](_assets/x.png)',
    )
  })

  it('sends documents with HTML or footnotes to the source editor', () => {
    expect(needsSourceMode('Plain *text* with `<b>code</b>`')).toBe(false)
    expect(needsSourceMode('```html\n<div>in a code block</div>\n```')).toBe(false)
    expect(needsSourceMode('a < b and c > d')).toBe(false)
    expect(needsSourceMode('<details><summary>More</summary>text</details>')).toBe(true)
    expect(needsSourceMode('A claim.[^1]\n\n[^1]: Source')).toBe(true)
  })
})
