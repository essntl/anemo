import { describe, expect, it } from 'vitest'
import { countWords, PAGE_CHAR_LIMIT, truncateMiddle } from './truncate'

describe('truncateMiddle', () => {
  it('leaves short pages alone', () => {
    expect(truncateMiddle('short text')).toEqual({ text: 'short text', truncated: false, removedWords: 0 })
  })

  it('keeps the start and the end, marks the cut, and stays within the limit', () => {
    const paragraphs = Array.from({ length: 4000 }, (_, i) => `Paragraph ${i} has some words in it.`)
    const text = paragraphs.join('\n\n')
    const cut = truncateMiddle(text)
    expect(cut.truncated).toBe(true)
    expect(cut.text.length).toBeLessThanOrEqual(PAGE_CHAR_LIMIT)
    expect(cut.text.startsWith('Paragraph 0 ')).toBe(true)
    expect(cut.text.endsWith('Paragraph 3999 has some words in it.')).toBe(true)
    expect(cut.text).toMatch(/\[… [\d,]+ words left out …\]/)
    // Cut at paragraph boundaries: no half paragraph on either side of the marker.
    expect(cut.text).toMatch(/in it\.\n\n\[…/)
    expect(cut.text).toMatch(/…\]\n\nParagraph \d+ has/)
    expect(cut.removedWords).toBe(countWords(text) - countWords(cut.text.replace(/\[…[^\]]*\]/, '')))
  })

  it('keeps about two thirds of the room for the start', () => {
    const text = 'a '.repeat(200_000)
    const cut = truncateMiddle(text, 1000)
    const [head] = cut.text.split('[…')
    expect(head.length).toBeGreaterThan(550)
    expect(head.length).toBeLessThan(700)
  })
})
