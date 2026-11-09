import { describe, expect, it } from 'vitest'
import { htmlToMarkdown } from './markdown'

describe('htmlToMarkdown', () => {
  it('keeps structure: headings, emphasis, lists, tables, code, absolute links', () => {
    const md = htmlToMarkdown(
      '<h2>Cells</h2><p>The <strong>nucleus</strong> holds <em>DNA</em>. See <a href="/wiki/Cell">cell</a>.</p>' +
        '<ul><li>one</li><li>two</li></ul>' +
        '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>' +
        '<pre><code>print("hi")</code></pre>',
      'https://en.wikipedia.org/wiki/Biology',
    )
    expect(md).toContain('## Cells')
    expect(md).toContain('The **nucleus** holds *DNA*. See [cell](https://en.wikipedia.org/wiki/Cell).')
    expect(md).toContain('-   one')
    expect(md).toContain('| A | B |')
    expect(md).toContain('```\nprint("hi")\n```')
  })

  it('drops scripts, forms and unsafe links', () => {
    const md = htmlToMarkdown(
      '<p>Text<script>alert(1)</script></p><form><input value="secret"></form><a href="javascript:alert(1)">x</a><img src="data:image/png;base64,AAAA">',
      'https://a.example/',
    )
    expect(md).not.toMatch(/alert|secret|javascript|data:/)
    expect(md).toContain('Text')
  })
})
