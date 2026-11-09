/**
 * Pages over the length limit (about 30k tokens) keep their start and end; the middle is
 * cut at paragraph boundaries and marked, so the model knows something is missing.
 */
export const PAGE_TOKEN_LIMIT = 30_000
export const CHARS_PER_TOKEN = 4
export const PAGE_CHAR_LIMIT = PAGE_TOKEN_LIMIT * CHARS_PER_TOKEN // under the server's 130,000

export interface Cut {
  text: string
  truncated: boolean
  /** Words left out. */
  removedWords: number
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

/** Keeps about two thirds of the room for the start, one third for the end. */
export function truncateMiddle(text: string, limit = PAGE_CHAR_LIMIT): Cut {
  if (text.length <= limit) return { text, truncated: false, removedWords: 0 }
  const room = limit - 80 // the marker
  const headRoom = Math.floor((room * 2) / 3)
  const tailRoom = room - headRoom
  let head = text.slice(0, headRoom)
  let tail = text.slice(text.length - tailRoom)
  // End and start at a paragraph (or at least a line) when there is one nearby.
  const headBreak = Math.max(head.lastIndexOf('\n\n'), head.lastIndexOf('\n'))
  if (headBreak > headRoom * 0.8) head = head.slice(0, headBreak)
  const tailBreak = tail.indexOf('\n')
  if (tailBreak !== -1 && tailBreak < tailRoom * 0.2) tail = tail.slice(tailBreak + 1)
  const removed = text.slice(head.length, text.length - tail.length)
  const removedWords = countWords(removed)
  return {
    text: `${head.trimEnd()}\n\n[… ${removedWords.toLocaleString('en')} words left out …]\n\n${tail.trimStart()}`,
    truncated: true,
    removedWords,
  }
}
