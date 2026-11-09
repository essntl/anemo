/**
 * In-place translation that keeps the page's own markup.
 *
 * Only the text inside text nodes changes; elements (links, bold, italics, line breaks)
 * are never touched. Each block's text nodes are numbered and sent as
 * "<1>first</1><2>second</2>"; the model translates and keeps the markers, and each
 * marker's text goes back into its own node. Every original is kept, so a restore puts
 * the page back exactly.
 */

/** Elements whose text is never translated in place. */
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'CODE', 'PRE', 'KBD', 'SAMP', 'SVG', 'MATH', 'TEMPLATE', 'IFRAME'])
const BLOCK = /^(P|LI|TD|TH|BLOCKQUOTE|DD|DT|H[1-6]|FIGCAPTION|SUMMARY|CAPTION|LEGEND|LABEL|DIV|SECTION|ARTICLE|ASIDE|MAIN|HEADER|FOOTER|NAV|UL|OL|DL|TABLE|TR|TBODY|THEAD|FORM|FIELDSET|BODY)$/
const PAGE_BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, dd, dt, figcaption, summary, caption'
const PAGE_EXCLUDE = 'nav, header, footer, aside, form, script, style, noscript, code, pre, [contenteditable=""], [contenteditable="true"], [aria-hidden="true"]'

export interface Block {
  /** The element whose text it is (a paragraph, a list item, ...). */
  element: Element
  nodes: Text[]
}

/** Inside a field, an editor or code: never replaced in place (shown in the box instead). */
export function isEditable(node: Node | null): boolean {
  for (let el = node instanceof Element ? node : node?.parentElement ?? null; el; el = el.parentElement) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return true
    if (el instanceof HTMLElement && (el.isContentEditable || el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === '')) return true
  }
  return false
}

function skipped(node: Text): boolean {
  for (let el = node.parentElement; el; el = el.parentElement) if (SKIP.has(el.tagName)) return true
  return false
}

function blockOf(node: Node): Element {
  let el = node.parentElement
  while (el && !BLOCK.test(el.tagName)) el = el.parentElement
  return el ?? (node.ownerDocument as Document).body
}

/** Splits the text nodes at the range's ends, so the range covers whole text nodes. */
function splitAtRange(range: Range): void {
  const { startContainer, startOffset, endContainer, endOffset } = range
  if (endContainer instanceof Text && endOffset > 0 && endOffset < endContainer.length) {
    endContainer.splitText(endOffset)
  }
  if (startContainer instanceof Text && startOffset > 0 && startOffset < startContainer.length) {
    const rest = startContainer.splitText(startOffset)
    range.setStart(rest, 0)
    if (endContainer === startContainer) range.setEnd(rest, endOffset - startOffset)
  }
}

function group(nodes: Text[]): Block[] {
  const blocks: Block[] = []
  for (const node of nodes) {
    const element = blockOf(node)
    const last = blocks.at(-1)
    if (last && last.element === element) last.nodes.push(node)
    else blocks.push({ element, nodes: [node] })
  }
  return blocks
}

/** The selection's text, block by block (a paragraph partly selected: only that part). */
export function blocksInRange(range: Range): Block[] {
  splitAtRange(range)
  const root = range.commonAncestorContainer
  const doc = (root.ownerDocument ?? root) as Document
  const walker = doc.createTreeWalker(root instanceof Text ? root.parentNode! : root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (!n.data.trim() || skipped(n) || isEditable(n)) continue
    if (range.intersectsNode(n)) nodes.push(n)
  }
  return group(nodes)
}

/** The page's content blocks for "Translate page": paragraphs, list items, headings,
 *  cells …, outside navigation, headers, footers, forms and code. */
export function pageBlocks(root: ParentNode): Block[] {
  const out: Block[] = []
  for (const el of root.querySelectorAll(PAGE_BLOCKS)) {
    if (el.closest(PAGE_EXCLUDE)) continue
    // A block inside another one (a <p> in an <li>) is translated with its parent.
    if (el.parentElement?.closest(PAGE_BLOCKS)) continue
    const doc = el.ownerDocument
    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    const nodes: Text[] = []
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      if (n.data.trim() && !skipped(n) && !isEditable(n)) nodes.push(n)
    }
    if (nodes.length) out.push({ element: el, nodes })
  }
  return out
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/** "<1>first</1><2>second</2>": what the model is asked to translate. */
export function tagged(block: Block): string {
  return block.nodes.map((n, i) => `<${i + 1}>${esc(n.data.replace(/\s+/g, ' '))}</${i + 1}>`).join('')
}

/** Each marker's text, or null when markers are missing, doubled or unbalanced. */
export function parseTagged(output: string, count: number): string[] | null {
  const parts: (string | undefined)[] = new Array(count).fill(undefined)
  const re = /<(\d+)>([\s\S]*?)<\/\1>/g
  for (let m = re.exec(output); m; m = re.exec(output)) {
    const i = Number(m[1]) - 1
    if (i < 0 || i >= count || parts[i] !== undefined) return null
    parts[i] = unesc(m[2])
  }
  return parts.every((p) => p !== undefined) ? (parts as string[]) : null
}

/** Removes markers the model may have kept, for a translation that lost its structure. */
export function stripMarkers(output: string): string {
  return unesc(output.replace(/<\/?\d+>/g, ''))
}

export interface Applied {
  nodes: Text[]
  originals: string[]
  translated: string[]
}

function keepSpaces(original: string, text: string): string {
  const lead = /^\s*/.exec(original)![0]
  const trail = /\s*$/.exec(original)![0]
  return lead + text.trim() + trail
}

/** Puts the translation into the block's text nodes. A translation whose markers don't
 *  match goes into the first node whole (text right, inline formatting lost). */
export function apply(block: Block, output: string): Applied {
  const parts = parseTagged(output, block.nodes.length)
  const originals = block.nodes.map((n) => n.data)
  let translated: string[]
  if (parts) {
    translated = block.nodes.map((n, i) => keepSpaces(n.data, parts[i]))
  } else {
    // All in the first node: its leading space, the last node's trailing space.
    const first = originals[0]
    const last = originals[originals.length - 1]
    const whole = /^\s*/.exec(first)![0] + stripMarkers(output).trim() + /\s*$/.exec(last)![0]
    translated = block.nodes.map((_, i) => (i === 0 ? whole : ''))
  }
  block.nodes.forEach((n, i) => {
    n.data = translated[i]
  })
  return { nodes: block.nodes, originals, translated }
}

/** Puts the original text back. */
export function restore(applied: Applied): void {
  applied.nodes.forEach((n, i) => {
    n.data = applied.originals[i]
  })
}

/** Words (tokens with a letter or a digit; punctuation alone isn't one). */
export function wordCount(blocks: Block[]): number {
  const words = (t: string) => t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length
  return blocks.reduce((sum, b) => sum + words(b.nodes.map((n) => n.data).join('')), 0)
}
