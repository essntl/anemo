/**
 * Find in the open chat: the matches are marked with the CSS Custom Highlight API (no
 * elements are added to the messages), and one is the current match.
 */
const ALL = 'chat-find'
const CURRENT = 'chat-find-current'

/** Every place `query` occurs in the text under `root` (case ignored), in reading order. */
export function findRanges(root: Node, query: string): Range[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const out: Range[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.nodeValue ?? '').toLowerCase()
    for (let at = text.indexOf(q); at !== -1; at = text.indexOf(q, at + q.length)) {
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + q.length)
      out.push(range)
    }
  }
  return out
}

export function showMatches(ranges: Range[], current: number): void {
  if (typeof Highlight === 'undefined' || !CSS.highlights) return
  CSS.highlights.set(ALL, new Highlight(...ranges))
  const now = ranges[current]
  if (now) {
    CSS.highlights.set(CURRENT, new Highlight(now))
    const el = now.startContainer.parentElement
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  } else {
    CSS.highlights.delete(CURRENT)
  }
}

export function clearMatches(): void {
  if (typeof CSS === 'undefined' || !CSS.highlights) return
  CSS.highlights.delete(ALL)
  CSS.highlights.delete(CURRENT)
}
