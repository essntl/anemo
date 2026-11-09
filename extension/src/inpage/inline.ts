/**
 * In-page translate and explain (feature 5), injected on demand after a right-click.
 *
 * It talks to Anemo only through the extension (a port to the service worker), never
 * directly, and holds no token. Translations change only the text inside the page's own
 * elements (see markers.ts); they are marked with a faint underline (CSS Custom Highlight,
 * no extra elements), show the original on hover, and can be restored one by one or all
 * at once. Text in fields, editors and code is never replaced: it is shown in the box.
 */
import { apply, blocksInRange, isEditable, pageBlocks, restore, tagged, wordCount, type Applied, type Block } from './markers'
import { getUi, hideOriginal, hideToast, isOverPopover, showBox, showOriginal, toast, type Box } from './ui'

export const ASK_ABOVE_WORDS = 3000
export const BREAKDOWN_MAX_WORDS = 8
export const REAPPLY_MS = 10_000

type FromWorker =
  | { type: 'delta'; id: string; text: string }
  | { type: 'done'; id: string }
  | { type: 'error'; id: string; message: string }
  | { type: 'translated'; id: string; text: string }
  | { type: 'handoff'; ok: boolean; message?: string }

let port: chrome.runtime.Port | null = null
const listeners = new Map<string, (m: FromWorker) => void>()
let seq = 0

function connect(): chrome.runtime.Port {
  if (port) return port
  const p = chrome.runtime.connect({ name: 'anemo-inline' })
  p.onMessage.addListener((m: FromWorker) => {
    if ('id' in m) listeners.get(m.id)?.(m)
    else if (m.type === 'handoff' && !m.ok) toast(m.message ?? 'Open the Anemo panel to continue.', [], 6000)
  })
  p.onDisconnect.addListener(() => {
    port = null
    for (const [id, fn] of listeners) fn({ type: 'error', id, message: 'The connection to the extension was lost. Try again.' })
    listeners.clear()
  })
  port = p
  return p
}

function request(message: Record<string, unknown>, on: (m: FromWorker) => void): string {
  const id = `r${++seq}`
  listeners.set(id, on)
  connect().postMessage({ ...message, id })
  return id
}

function translateText(text: string, targetLanguage: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const id = request({ type: 'translate', text, targetLanguage }, (m) => {
      listeners.delete(id)
      if (m.type === 'translated') resolve(m.text)
      else if (m.type === 'error') reject(new Error(m.message))
    })
  })
}

// -- selection helpers ----------------------------------------------------------------------

function selectionRange(): Range | null {
  const sel = window.getSelection()
  return sel && sel.rangeCount > 0 && sel.toString().trim() ? sel.getRangeAt(0) : null
}

function anchorRect(range: Range | null): DOMRect {
  const rect = range?.getBoundingClientRect()
  if (rect && (rect.width || rect.height)) return rect
  // A selection in a field has no rect of its own: use the field.
  const active = document.activeElement
  return active?.getBoundingClientRect() ?? new DOMRect(window.innerWidth / 2 - 200, 80, 0, 0)
}

function selectedText(range: Range | null): string {
  const active = document.activeElement
  if (active instanceof HTMLTextAreaElement || (active instanceof HTMLInputElement && typeof active.selectionStart === 'number')) {
    const { selectionStart: s, selectionEnd: e, value } = active
    if (s !== null && e !== null && e > s) return value.slice(s, e)
  }
  return range?.toString() ?? window.getSelection()?.toString() ?? ''
}

function paragraphAround(range: Range | null): string {
  let node: Node | null = range?.commonAncestorContainer ?? null
  while (node && node.nodeType !== Node.ELEMENT_NODE) node = node.parentNode
  let el = node as HTMLElement | null
  while (el && el !== document.body && !/^(P|LI|TD|TH|BLOCKQUOTE|DD|DT|H[1-6]|PRE|FIGCAPTION|ARTICLE|SECTION|DIV)$/.test(el.tagName)) el = el.parentElement
  return (el?.innerText || el?.textContent || '').trim().slice(0, 4000)
}

function words(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length
}

// -- explain --------------------------------------------------------------------------------

function handoff(type: 'openChat' | 'save', selection: string, explanation: string): void {
  connect().postMessage({ type, selection, explanation })
}

export function explain(targetLanguage: string): void {
  const range = selectionRange()
  const text = selectedText(range).trim().slice(0, 4000)
  if (!text) {
    toast('Select some text first.', [], 4000)
    return
  }
  const box = showBox(anchorRect(range), 'Explain')
  box.setQuote(text)
  box.setWaiting('Thinking')
  let answer = ''
  const id = request(
    {
      type: 'explain',
      text,
      context: paragraphAround(range),
      url: location.href,
      title: document.title,
      targetLanguage,
      breakdown: words(text) <= BREAKDOWN_MAX_WORDS,
    },
    (m) => {
      if (m.type === 'delta') {
        answer += m.text
        box.setMarkdown(answer)
      } else if (m.type === 'done') {
        listeners.delete(id)
        box.setActions([
          { label: 'Copy', run: () => void navigator.clipboard.writeText(answer) },
          { label: 'Open in chat', run: () => handoff('openChat', text, answer) },
          { label: 'Save to Anemo', primary: true, run: () => handoff('save', text, answer) },
        ])
      } else if (m.type === 'error') {
        listeners.delete(id)
        box.setError(m.message)
      }
    },
  )
}

// -- translate ------------------------------------------------------------------------------

interface Entry {
  block: Block
  applied: Applied
  at: number
  reverted: boolean
}

const entries: Entry[] = []
const byNode = new WeakMap<Text, Entry>()
let highlight: Highlight | null = null
let observer: MutationObserver | null = null
let revertNoticeShown = false
let stopPage = false

function reportStatus(): void {
  connect().postMessage({ type: 'status', translated: entries.length })
}

function ensureMarking(): void {
  if (highlight) return
  highlight = new Highlight()
  CSS.highlights.set('anemo-translated', highlight)
  const sheet = new CSSStyleSheet()
  sheet.replaceSync('::highlight(anemo-translated) { text-decoration: underline dotted rgb(52 120 246 / 0.75); text-decoration-thickness: 1.5px; text-underline-offset: 3px; }')
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
  observer = new MutationObserver(() => watchReverts())
  observer.observe(document.body, { subtree: true, characterData: true, childList: true })
  document.addEventListener('mousemove', onHover, { passive: true })
  document.addEventListener('click', onClickTranslated, true)
}

function mark(entry: Entry): void {
  ensureMarking()
  for (const node of entry.applied.nodes) {
    if (!node.data.trim()) continue
    const r = document.createRange()
    r.selectNodeContents(node)
    highlight!.add(r)
    byNode.set(node, entry)
  }
}

function unmark(entry: Entry): void {
  if (!highlight) return
  for (const r of [...highlight]) {
    if (r instanceof Range && entry.applied.nodes.includes(r.startContainer as Text)) highlight.delete(r)
  }
}

/** Sites that re-render (React and the like) may put their own text back. For a few
 *  seconds the translation is put back too; after that, a notice says so. */
function watchReverts(): void {
  const now = Date.now()
  let lost = false
  for (const entry of entries) {
    if (entry.reverted) continue
    entry.applied.nodes.forEach((node, i) => {
      const expected = entry.applied.translated[i]
      if (node.data === expected) return
      if (node.isConnected && now - entry.at < REAPPLY_MS) {
        node.data = expected
      } else if (!entry.reverted) {
        entry.reverted = true
        lost = true
      }
    })
  }
  if (lost && !revertNoticeShown) {
    revertNoticeShown = true
    toast('The site reverted some of the translated text.', [{ label: 'OK', run: hideToast }], 8000)
  }
}

function originalOf(entry: Entry): string {
  return entry.applied.originals.join('').replace(/\s+/g, ' ').trim()
}

function restoreEntry(entry: Entry): void {
  observer?.disconnect()
  restore(entry.applied)
  unmark(entry)
  entries.splice(entries.indexOf(entry), 1)
  observer?.observe(document.body, { subtree: true, characterData: true, childList: true })
  reportStatus()
}

export function restoreAll(): number {
  const count = entries.length
  observer?.disconnect()
  for (const entry of [...entries]) {
    restore(entry.applied)
    unmark(entry)
  }
  entries.length = 0
  stopPage = true
  hideOriginal()
  hideToast()
  if (count) toast('The original text is back.', [], 3000)
  observer?.observe(document.body, { subtree: true, characterData: true, childList: true })
  reportStatus()
  return count
}

function entryAt(x: number, y: number): Entry | null {
  // caretPositionFromPoint from Chrome 128; caretRangeFromPoint before that.
  const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
  const node = document.caretPositionFromPoint ? document.caretPositionFromPoint(x, y)?.offsetNode : doc.caretRangeFromPoint?.(x, y)?.startContainer
  return node instanceof Text ? (byNode.get(node) ?? null) : null
}

let hoverTimer = 0
function onHover(e: MouseEvent): void {
  if (isOverPopover(e)) return
  window.clearTimeout(hoverTimer)
  hoverTimer = window.setTimeout(() => {
    const entry = entryAt(e.clientX, e.clientY)
    if (!entry || entry.reverted) return
    showOriginal(entry.block.element.getBoundingClientRect(), originalOf(entry), () => restoreEntry(entry))
  }, 450)
}

function onClickTranslated(e: MouseEvent): void {
  if (!e.isTrusted || isOverPopover(e)) return
  const entry = entryAt(e.clientX, e.clientY)
  if (entry && !entry.reverted) showOriginal(entry.block.element.getBoundingClientRect(), originalOf(entry), () => restoreEntry(entry))
}

async function translateBlocks(blocks: Block[], targetLanguage: string, label: string): Promise<void> {
  let done = 0
  let failed = 0
  stopPage = false
  const progress = () =>
    toast(`${label}… ${done} of ${blocks.length}`, [{ label: 'Stop', run: () => (stopPage = true) }, { label: 'Restore all', run: () => void restoreAll() }])
  progress()
  // A few at a time (the worker queues them), applied as each one comes back.
  const queue = [...blocks]
  const runOne = async (): Promise<void> => {
    for (let block = queue.shift(); block && !stopPage; block = queue.shift()) {
      try {
        const out = await translateText(tagged(block), targetLanguage)
        if (stopPage) return
        observer?.disconnect()
        const applied = apply(block, out)
        observer?.observe(document.body, { subtree: true, characterData: true, childList: true })
        const entry: Entry = { block, applied, at: Date.now(), reverted: false }
        entries.push(entry)
        mark(entry)
      } catch {
        failed += 1
      }
      done += 1
      progress()
    }
  }
  await Promise.all([runOne(), runOne(), runOne()])
  reportStatus()
  if (stopPage && done < blocks.length) {
    toast(`Stopped after ${done} of ${blocks.length}.`, [{ label: 'Restore all', run: () => void restoreAll() }], 6000)
  } else if (failed) {
    toast(`${failed} part${failed === 1 ? '' : 's'} couldn’t be translated.`, [{ label: 'Restore all', run: () => void restoreAll() }], 8000)
  } else {
    toast('Translated. Hover the underlined text for the original.', [{ label: 'Restore all', run: () => void restoreAll() }], 6000)
  }
}

/** A translation shown in the box (fields, editors, or where nothing can be replaced). */
async function translateInBox(text: string, targetLanguage: string, range: Range | null, why: string): Promise<void> {
  const box = showBox(anchorRect(range), 'Translation')
  box.setQuote(text.slice(0, 400))
  box.setWaiting('Translating')
  try {
    const out = await translateText(text.slice(0, 12_000), targetLanguage)
    box.setText(out)
    box.setActions([{ label: 'Copy', primary: true, run: () => void navigator.clipboard.writeText(out) }])
    if (why) box.setTitle(`Translation (${why})`)
  } catch (err) {
    box.setError((err as Error).message)
  }
}

export function translateSelection(targetLanguage: string): void {
  const range = selectionRange()
  const text = selectedText(range).trim()
  if (!text) {
    toast('Select some text first.', [], 4000)
    return
  }
  if (!range || isEditable(range.commonAncestorContainer) || document.activeElement instanceof HTMLTextAreaElement || document.activeElement instanceof HTMLInputElement) {
    void translateInBox(text, targetLanguage, range, 'text in a field is left as it is')
    return
  }
  const blocks = blocksInRange(range)
  if (blocks.length === 0) {
    void translateInBox(text, targetLanguage, range, '')
    return
  }
  window.getSelection()?.removeAllRanges()
  const count = wordCount(blocks)
  if (count > ASK_ABOVE_WORDS) {
    const box: Box = showBox(anchorRect(range), 'Translate in place?')
    box.setText(`The selection has ${count.toLocaleString()} words. Translate all of it here on the page?`)
    box.setActions([
      { label: 'Cancel', run: () => box.close() },
      { label: 'Translate', primary: true, run: () => { box.close(); void translateBlocks(blocks, targetLanguage, 'Translating') } },
    ])
    return
  }
  void translateBlocks(blocks, targetLanguage, 'Translating')
}

export function translatePage(targetLanguage: string): void {
  const translated = new Set(entries.map((e) => e.block.element))
  const blocks = pageBlocks(document.body).filter((b) => !translated.has(b.element))
  if (blocks.length === 0) {
    toast('Nothing (more) to translate on this page.', [], 4000)
    return
  }
  // What you can see first, then the rest in page order.
  const inView = (b: Block) => {
    const r = b.element.getBoundingClientRect()
    return r.bottom > 0 && r.top < window.innerHeight
  }
  const ordered = [...blocks.filter(inView), ...blocks.filter((b) => !inView(b))]
  void translateBlocks(ordered, targetLanguage, 'Translating the page')
}

/** Made available to the extension's next executeScript call (isolated world only). */
export function install(): void {
  getUi()
  ;(window as unknown as { __anemoInline?: unknown }).__anemoInline = {
    explain,
    translateSelection,
    translatePage,
    restoreAll,
    count: () => entries.length,
  }
}
