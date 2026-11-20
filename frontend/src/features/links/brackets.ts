/**
 * `[[` in a plain text box (an event's notes) opens the link picker; the picked item
 * goes in as an ordinary Markdown link with its canonical reference, where the
 * brackets were.
 */

/** Where `[[` was just typed (the position of the first bracket), or -1. */
export function bracketsTyped(before: string, after: string, cursor: number): number {
  if (after.length !== before.length + 1 || cursor < 2) return -1
  return after.slice(cursor - 2, cursor) === '[[' ? cursor - 2 : -1
}

/** The Markdown link for an item: `[Title](/documents/<id>)` (brackets in the title are kept out). */
export function markdownLink(title: string, href: string): string {
  return `[${title.replace(/[[\]]/g, '')}](${href})`
}

/** The text with the two brackets at `at` replaced by `link`, and where the cursor goes. */
export function insertLink(text: string, at: number, link: string): { text: string; cursor: number } {
  const next = text.slice(0, at) + link + text.slice(at + 2)
  return { text: next, cursor: at + link.length }
}
