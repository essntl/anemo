import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './render'

describe('renderMarkdown (in-page box)', () => {
  it('renders Markdown, tables, highlighted code with a copy button, and math as MathML', () => {
    const html = renderMarkdown('**Fotosyntese** means *photosynthesis*.\n\n| Word | Meaning |\n|---|---|\n| foto | light |\n\n```python\nprint(1)\n```\n\n$E = mc^2$')
    expect(html).toContain('<strong>Fotosyntese</strong>')
    expect(html).toContain('<table>')
    expect(html).toContain('class="hljs"')
    expect(html).toContain('copy-code')
    expect(html).toContain('<math')
  })

  it('removes scripts, event handlers, images and unsafe links', () => {
    const html = renderMarkdown('<script>alert(1)</script><img src=x onerror=alert(2)>\n\nSee [a](javascript:alert(3)) and [b](https://ok.example) and <a href="x" onclick="y">c</a>.')
    expect(html).not.toMatch(/script|onerror|onclick|<img|javascript:/)
    expect(html).toContain('href="https://ok.example"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })
})
