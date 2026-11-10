/**
 * Getting from a document's outline to the heading itself, in either editor.
 *
 * The outline is read from the Markdown text and the rich editor draws that text as
 * headings, so a heading is found by its place among the headings of the same text
 * (the second "Marriage" in the outline is the second "Marriage" on the page), never by
 * a link's slug, which two headings can share and which changes with every character.
 */
import { EditorView } from '@uiw/react-codemirror'
import type { OutlineItem } from './outline'
import { revealElement } from './passage'

const HEADINGS = '.ProseMirror :is(h1, h2, h3)'
const norm = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase()

/** For each title, which occurrence of that title it is: "marriage#0", "marriage#1", … */
function occurrences(titles: string[]): string[] {
  const seen = new Map<string, number>()
  return titles.map((title) => {
    const key = norm(title)
    const n = seen.get(key) ?? 0
    seen.set(key, n + 1)
    return `${key}#${n}`
  })
}

/** The headings the rich editor shows under `root`, in order. */
function shownHeadings(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(HEADINGS)]
}

/** The heading on the page that an outline item stands for (rich editor), or null. */
export function headingFor(root: HTMLElement, outline: OutlineItem[], index: number): HTMLElement | null {
  const shown = shownHeadings(root)
  if (!shown.length || !outline[index]) return null
  const wanted = occurrences(outline.map((o) => o.title))[index]
  const at = occurrences(shown.map((h) => h.textContent ?? '')).indexOf(wanted)
  if (at >= 0) return shown[at]
  // The page words a heading differently than the text (rare): go by position.
  return shown.length === outline.length ? shown[index] : null
}

/**
 * Shows the heading an outline item stands for: scrolls it to the top of the editor and
 * marks it. In the Markdown editor, which only draws the lines in view, it goes to the
 * heading's line instead (`lineOffset`: the lines of front matter above the text the
 * outline was read from). Returns whether it got there.
 */
export function jumpToHeading(root: HTMLElement, outline: OutlineItem[], index: number, lineOffset = 0): boolean {
  const heading = headingFor(root, outline, index)
  if (heading) {
    revealElement(root, heading)
    return true
  }
  const editor = root.querySelector<HTMLElement>('.cm-editor')
  const view = editor ? EditorView.findFromDOM(editor) : null
  const item = outline[index]
  if (!view || !item) return false
  const line = view.state.doc.line(Math.min(view.state.doc.lines, item.line + lineOffset + 1))
  view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 12 }) })
  view.focus()
  return true
}

/**
 * The outline item you are reading under: the last heading at or above the top of the
 * rich editor's scrolled view. -1 before the first heading, or outside the rich editor.
 */
export function activeHeading(root: HTMLElement, outline: OutlineItem[]): number {
  const shown = shownHeadings(root)
  if (!shown.length) return -1
  const scroller = shown[0].closest<HTMLElement>('.overflow-y-auto')
  const top = (scroller ?? root).getBoundingClientRect().top + 32
  let current = -1
  for (let i = 0; i < shown.length; i++) {
    if (shown[i].getBoundingClientRect().top > top) break
    current = i
  }
  if (current < 0) return -1
  const wanted = occurrences(shown.map((h) => h.textContent ?? ''))[current]
  const at = occurrences(outline.map((o) => o.title)).indexOf(wanted)
  return at >= 0 ? at : shown.length === outline.length ? current : -1
}
