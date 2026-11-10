/**
 * A link can point at a part of a document: /documents/<id>#<heading> for a section,
 * or /documents/<id>#text=<a few words> for a passage (what an answer quotes). The
 * browser's own text fragments (#:~:text=…) are understood too. Opening such a link
 * scrolls to that part and highlights it, without changing the document.
 */
import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react'

/** "tech-services/side-hustle-plan.md" (or with documents/ in front, or without .md) -> its workspace path. */
export function documentPathFromAddress(address: string): string {
  let path = address
  try {
    path = decodeURIComponent(address)
  } catch {
    // Keep it as written.
  }
  path = path.replace(/^\/+|\/+$/g, '')
  if (!path.startsWith('documents/')) path = `documents/${path}`
  if (!/\.md$/i.test(path)) path = `${path}.md`
  return path
}

export type Passage = { heading: string } | { text: string }

/** The slug of a heading, as in "#heading" links: "Scams to watch for" -> "scams-to-watch-for". */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .trim()
    .replace(/[\s-]+/g, '-')
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '))
  } catch {
    return value
  }
}

/** What a link's "#…" points at, or null for none. */
export function parsePassage(hash: string): Passage | null {
  const raw = hash.replace(/^#/, '')
  if (!raw) return null
  // #:~:text=[prefix-,]start[,end][,-suffix]: the start is what to find.
  const fragment = /(?:^|:~:)text=([^&]*)/.exec(raw)
  if (fragment) {
    const parts = fragment[1].split(',').filter((p) => !p.endsWith('-') && !p.startsWith('-'))
    const text = decode(parts[0] ?? '').trim()
    return text ? { text } : null
  }
  const heading = decode(raw).trim()
  return heading ? { heading } : null
}

const SPACE = /\s+/g
const norm = (s: string) => s.replace(SPACE, ' ').toLowerCase()

/** The text nodes under `root`, with where each starts in their joined text. */
function textNodes(root: Node): { node: Text; start: number }[] {
  const nodes: { node: Text; start: number }[] = []
  const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let at = 0
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n as Text, start: at })
    at += (n as Text).data.length
  }
  return nodes
}

/** A range over the first place `needle` is written under `root` (any case, any spacing). */
function findText(root: HTMLElement, needle: string): Range | null {
  const target = norm(needle.trim())
  if (!target) return null
  const nodes = textNodes(root)
  const joined = nodes.map((n) => n.node.data).join('')
  // Normalize spacing while keeping a map back to positions in the joined text.
  let flat = ''
  const back: number[] = []
  for (let i = 0; i < joined.length; i++) {
    const ch = joined[i]
    if (/\s/.test(ch)) {
      if (flat.endsWith(' ')) continue
      flat += ' '
    } else {
      flat += ch.toLowerCase()
    }
    back.push(i)
  }
  const found = flat.indexOf(target)
  if (found < 0) return null
  const from = back[found]
  const to = back[found + target.length - 1] + 1
  const locate = (pos: number, end: boolean) => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const { node, start } = nodes[i]
      if (end ? pos > start : pos >= start) return { node, offset: pos - start }
    }
    return null
  }
  const a = locate(from, false)
  const b = locate(to, true)
  if (!a || !b) return null
  const range = root.ownerDocument!.createRange()
  range.setStart(a.node, a.offset)
  range.setEnd(b.node, b.offset)
  return range
}

/**
 * Where a passage is under `root`: a heading whose slug or text matches, or the first
 * place the quoted text is written. A quote that isn't found as a whole is looked for
 * by its first words (answers sometimes shorten or reword the end).
 */
export function findPassage(root: HTMLElement, passage: Passage): Range | null {
  const doc = root.ownerDocument!
  if ('heading' in passage) {
    const wanted = slugify(passage.heading)
    for (const h of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      const text = h.textContent ?? ''
      if (slugify(text) === wanted || norm(text) === norm(passage.heading)) {
        const range = doc.createRange()
        range.selectNodeContents(h)
        return range
      }
    }
    // "#some-words" may also be words from the text rather than a heading.
    return findText(root, passage.heading.replace(/-/g, ' '))
  }
  const whole = findText(root, passage.text)
  if (whole) return whole
  const words = passage.text.trim().split(SPACE)
  for (const n of [8, 5, 3]) {
    if (words.length > n) {
      const start = findText(root, words.slice(0, n).join(' '))
      if (start) return start
    }
  }
  return null
}

const HIGHLIGHT = 'passage'

/**
 * Scrolls to the passage and highlights it (CSS Custom Highlight API, so the editor's
 * text isn't touched; without it, scrolling alone). Returns whether it was found.
 */
export function showPassage(root: HTMLElement, passage: Passage): boolean {
  const range = findPassage(root, passage)
  if (!range) return false
  const target = range.startContainer.parentElement
  target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  highlight(root, range)
  return true
}

/**
 * Shows an element of the document (a heading chosen in the outline): at the top of the
 * view, at once (a long document scrolled smoothly can stop short), and marked.
 */
export function revealElement(root: HTMLElement, el: HTMLElement): void {
  el.scrollIntoView({ block: 'start' })
  const range = el.ownerDocument.createRange()
  range.selectNodeContents(el)
  highlight(root, range)
}

/** Marks a range until you start working in the document (CSS Custom Highlight API). */
function highlight(root: HTMLElement, range: Range): void {
  const css = globalThis.CSS as (typeof CSS & { highlights?: Map<string, unknown> }) | undefined
  const Highlight = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight
  if (css?.highlights && Highlight) {
    css.highlights.set(HIGHLIGHT, new Highlight(range))
    // Gone once you start working in the document.
    const clear = () => {
      css.highlights?.delete(HIGHLIGHT)
      root.removeEventListener('pointerdown', clear)
      root.removeEventListener('keydown', clear)
    }
    root.addEventListener('pointerdown', clear)
    root.addEventListener('keydown', clear)
  }
}

/**
 * Shows the passage the page's "#…" points at, once the editor has drawn the text
 * (it is looked for over a few frames). Says so when a quoted passage isn't there.
 */
export function useShowPassage(root: RefObject<HTMLElement | null>, hash: string, onMissing: () => void) {
  const missing = useRef(onMissing)
  useLayoutEffect(() => {
    missing.current = onMissing
  })
  useEffect(() => {
    const passage = parsePassage(hash)
    if (!passage) return
    let frame = 0
    let tries = 0
    const attempt = () => {
      const el = root.current
      const scope = el?.querySelector<HTMLElement>('.ProseMirror, .cm-content') ?? null
      if (scope && (scope.textContent ?? '').trim() && showPassage(scope, passage)) return
      if (++tries < 30) frame = requestAnimationFrame(attempt)
      else if ('text' in passage) missing.current()
    }
    frame = requestAnimationFrame(attempt)
    return () => cancelAnimationFrame(frame)
  }, [root, hash])
}
