import { describe, expect, it } from 'vitest'
import { outlineOf, wordCount } from './outline'

describe('outlineOf', () => {
  it('lists the headings of levels 1 to 3 in order, with the line each is on', () => {
    const text = '# Methods\n\nSome text.\n\n## 3.1 Participants\n\n### Pre-test\n\n#### Too deep\n\n## 3.2 Procedure\n'
    expect(outlineOf(text)).toEqual([
      { level: 1, title: 'Methods', slug: 'methods', line: 0 },
      { level: 2, title: '3.1 Participants', slug: '31-participants', line: 4 },
      { level: 3, title: 'Pre-test', slug: 'pre-test', line: 6 },
      { level: 2, title: '3.2 Procedure', slug: '32-procedure', line: 10 },
    ])
  })

  it('skips what is inside a code block', () => {
    expect(outlineOf('## Real\n\n```sh\n# a comment\n```\n\n~~~\n## also code\n~~~\n\n## After').map((h) => h.title)).toEqual(['Real', 'After'])
  })

  it('shows titles as they read: no marks, escapes or entities', () => {
    expect(outlineOf('## **Bold** and `code` with a [link](https://example.org) ##')[0].title).toBe('Bold and code with a link')
    // What the editor writes for "&", "<" and a numbered title.
    expect(outlineOf('# Full Contents &amp; Rebuild')[0].title).toBe('Full Contents & Rebuild')
    expect(outlineOf('## a &lt; b &#38; c &#x26; d')[0].title).toBe('a < b & c & d')
    expect(outlineOf('## 0\\.1 Folder\\_tree \\*kept\\*')[0].title).toBe('0.1 Folder_tree *kept*')
    expect(outlineOf('## Tom &unknown; Jerry')[0].title).toBe('Tom &unknown; Jerry')
    expect(outlineOf('#NoSpace\n##\n')).toEqual([])
  })
})

describe('wordCount', () => {
  it('counts words as the server does', () => {
    expect(wordCount('## A heading\n\n- one\n- two three\n\n---')).toBe(5)
    // Like the server's \w+: an apostrophe or a dash splits a word, a number counts.
    expect(wordCount("It's a well-known fact: 42.")).toBe(7)
    expect(wordCount('')).toBe(0)
  })
})
