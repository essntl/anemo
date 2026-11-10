import { describe, expect, it } from 'vitest'
import { outlineOf, wordCount } from './outline'

describe('outlineOf', () => {
  it('lists the headings of levels 1 to 3 in order', () => {
    const text = '# Methods\n\nSome text.\n\n## 3.1 Participants\n\n### Pre-test\n\n#### Too deep\n\n## 3.2 Procedure\n'
    expect(outlineOf(text)).toEqual([
      { level: 1, title: 'Methods', slug: 'methods' },
      { level: 2, title: '3.1 Participants', slug: '31-participants' },
      { level: 3, title: 'Pre-test', slug: 'pre-test' },
      { level: 2, title: '3.2 Procedure', slug: '32-procedure' },
    ])
  })

  it('skips what is inside a code block', () => {
    expect(outlineOf('## Real\n\n```sh\n# a comment\n```\n\n~~~\n## also code\n~~~\n\n## After')).toEqual([
      { level: 2, title: 'Real', slug: 'real' },
      { level: 2, title: 'After', slug: 'after' },
    ])
  })

  it('leaves formatting marks out of the titles', () => {
    expect(outlineOf('## **Bold** and `code` with a [link](https://example.org) ##')[0].title).toBe('Bold and code with a link')
    expect(outlineOf('#NoSpace\n##\n')).toEqual([])
  })
})

describe('wordCount', () => {
  it('counts words, not marks', () => {
    expect(wordCount('## A heading\n\n- one\n- two three\n\n---')).toBe(5)
    expect(wordCount('')).toBe(0)
  })
})
