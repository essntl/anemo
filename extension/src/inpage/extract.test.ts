import { describe, expect, it } from 'vitest'
import { extract } from './extract'

const article = Array.from({ length: 12 }, (_, i) => `<p>Paragraph ${i}: mitochondria produce most of the chemical energy needed to power the cell's biochemical reactions.</p>`).join('')

describe('extract (runs in the page)', () => {
  it('reads the main content with Readability, as Markdown, without menus', () => {
    document.title = 'Mitochondria – Encyclopedia'
    document.body.innerHTML = `<nav><a href="/">Home</a><a href="/login">Log in</a></nav><article><h1>Mitochondria</h1>${article}</article><footer>© 2026</footer>`
    const out = extract()
    expect(out.method).toBe('readability')
    expect(out.markdown).toContain('Paragraph 0: mitochondria produce')
    expect(out.markdown).not.toContain('Log in')
    expect(out.text.length).toBeGreaterThan(500)
  })

  it('falls back to the selection, then the visible text', () => {
    document.title = 'Short'
    document.body.innerHTML = '<p id="p">Tiny page with a <b id="b">selected phrase</b> inside.</p>'
    const range = document.createRange()
    range.selectNodeContents(document.getElementById('b')!)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    const withSelection = extract()
    expect(withSelection.method).toBe('selection')
    expect(withSelection.text).toBe('selected phrase')
    expect(withSelection.selectionContext).toContain('Tiny page with a')
    window.getSelection()!.removeAllRanges()
    expect(extract().method).toBe('body')
  })
})
