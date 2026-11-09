/**
 * The in-page UI: the explain/translate box, the "original text" popover over translated
 * text, and short notices. Everything lives in one closed Shadow DOM root, so the page's
 * CSS can't change it and the page's scripts can't reach into it; styles come from a
 * constructable stylesheet, which a page's CSP doesn't block. Its own colours (Anemo's,
 * light or dark with the system) look the same on light and dark sites.
 *
 * Nothing personal is ever shown here: only the selection, Anemo's answer about it, and
 * buttons. Document lists and the like stay in the side panel.
 */
import { E2E } from '@/shared/env'
import { renderMarkdown } from './render'

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.root {
  --bg: #ffffff; --surface: #f4f5f8; --hover: #e7e9ee; --text: #15171c; --muted: #6a7080;
  --border: rgb(15 20 30 / 0.12); --accent: #3478f6; --accent-soft: rgb(52 120 246 / 0.12);
  --error: #dc3b3b; --shadow: 0 2px 6px rgb(15 20 30 / 0.08), 0 16px 40px rgb(15 20 30 / 0.18);
  --code-keyword: #a626a4; --code-string: #50a14f; --code-number: #986801; --code-comment: #a0a1a7; --code-function: #4078f2; --code-type: #c18401;
  font: 14px/1.55 Inter, MiSans, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  color: var(--text); -webkit-font-smoothing: antialiased;
}
@media (prefers-color-scheme: dark) {
  .root {
    --bg: #181b22; --surface: #1f232b; --hover: #2a2f39; --text: #eceef2; --muted: #9aa1ae;
    --border: rgb(255 255 255 / 0.12); --accent: #5b9bff; --accent-soft: rgb(91 155 255 / 0.18);
    --error: #f06464; --shadow: 0 2px 6px rgb(0 0 0 / 0.4), 0 16px 40px rgb(0 0 0 / 0.5);
    --code-keyword: #c678dd; --code-string: #98c379; --code-number: #d19a66; --code-comment: #7f848e; --code-function: #61afef; --code-type: #e5c07b;
  }
}
.box {
  position: absolute; width: min(420px, calc(100vw - 24px)); max-height: min(60vh, 520px);
  display: flex; flex-direction: column; background: var(--bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 14px; box-shadow: var(--shadow); overflow: hidden;
  pointer-events: auto; text-align: left;
}
.head { display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 12px; border-bottom: 1px solid var(--border); cursor: grab; user-select: none; }
.head:active { cursor: grabbing; }
.logo { width: 18px; height: 18px; border-radius: 5px; background: var(--accent); flex: none; }
.title { flex: 1; min-width: 0; font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.icon { border: 0; background: none; color: var(--muted); width: 26px; height: 26px; border-radius: 7px; cursor: pointer; font-size: 16px; line-height: 1; }
.icon:hover { background: var(--hover); color: var(--text); }
.body { overflow: auto; padding: 10px 14px 12px; font-size: 13.5px; }
.quote { margin: 0 0 8px; padding-left: 8px; border-left: 3px solid var(--border); color: var(--muted); font-size: 12.5px; max-height: 5.5em; overflow: hidden; }
.foot { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--border); }
.btn { border: 0; border-radius: 9px; padding: 6px 11px; font: 500 12.5px/1.2 inherit; background: var(--surface); color: var(--text); cursor: pointer; white-space: nowrap; flex: none; }
.btn:hover { background: var(--hover); }
.btn.primary { background: var(--accent); color: #fff; }
.btn:disabled { opacity: 0.5; cursor: default; }
.muted { color: var(--muted); font-size: 12.5px; }
.error { color: var(--error); font-size: 13px; }
.dots::after { content: '…'; animation: blink 1s steps(3) infinite; }
@keyframes blink { 50% { opacity: 0.3; } }
.md p { margin: 0 0 8px; } .md > :last-child { margin-bottom: 0; }
.md ul, .md ol { margin: 0 0 8px; padding-left: 20px; }
.md a { color: var(--accent); }
.md table { border-collapse: collapse; margin: 0 0 8px; font-size: 12.5px; display: block; overflow-x: auto; }
.md th, .md td { border: 1px solid var(--border); padding: 3px 8px; text-align: left; }
.md th { background: var(--surface); }
.md code { font: 12px ui-monospace, 'JetBrains Mono', Menlo, Consolas, monospace; background: var(--surface); padding: 1px 4px; border-radius: 5px; }
.md .code { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; margin: 0 0 8px; background: var(--surface); }
.md .code-head { display: flex; justify-content: space-between; align-items: center; padding: 3px 8px; font-size: 11px; color: var(--muted); border-bottom: 1px solid var(--border); }
.md .code-head button { border: 0; background: none; color: var(--muted); cursor: pointer; font-size: 11px; }
.md pre { margin: 0; padding: 8px; overflow-x: auto; } .md pre code { background: none; padding: 0; }
.md .math { overflow-x: auto; margin: 0 0 8px; }
.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-built_in { color: var(--code-keyword); }
.hljs-string, .hljs-regexp, .hljs-addition { color: var(--code-string); }
.hljs-number, .hljs-symbol, .hljs-bullet { color: var(--code-number); }
.hljs-comment, .hljs-quote, .hljs-meta { color: var(--code-comment); font-style: italic; }
.hljs-title, .hljs-section { color: var(--code-function); }
.hljs-type, .hljs-class, .hljs-attr, .hljs-variable, .hljs-params { color: var(--code-type); }
/* The original text over a translated block. A fixed width: the host is 0 px wide, so a
   shrink-to-fit box would wrap after every word. */
.pop { position: absolute; width: min(380px, calc(100vw - 24px)); background: var(--bg); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow); padding: 10px 12px 10px; font-size: 13px; line-height: 1.5; pointer-events: auto; text-align: left; }
.pop .label { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; color: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
.pop .label::before { content: ''; width: 8px; height: 8px; border-radius: 3px; background: var(--accent); }
.pop .orig { color: var(--text); max-height: 12em; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.pop .actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); }
.toast { position: fixed; right: 16px; bottom: 16px; display: flex; align-items: center; gap: 8px; background: var(--bg); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow); padding: 8px 10px 8px 12px; font-size: 12.5px; pointer-events: auto; max-width: calc(100vw - 32px); }
`

export interface Ui {
  root: HTMLDivElement
  host: HTMLElement
}

let ui: Ui | null = null

/** The one host element (created on first use) and its closed shadow root. */
export function getUi(): Ui {
  if (ui && ui.host.isConnected) return ui
  const host = document.createElement('anemo-companion')
  host.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;'
  // Closed: the page can't reach in. The test build opens it so Playwright can look.
  const shadow = host.attachShadow({ mode: E2E ? 'open' : 'closed' })
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(CSS)
  shadow.adoptedStyleSheets = [sheet]
  const root = document.createElement('div')
  root.className = 'root'
  shadow.append(root)
  document.documentElement.append(host)
  ui = { root, host }
  // Anemo's accent colour (Settings → Appearance), as in the side panel.
  void chrome.storage?.local
    .get('accent')
    .then(({ accent }) => {
      if (typeof accent === 'string' && /^#[0-9a-f]{6}$/i.test(accent)) {
        root.style.setProperty('--accent', accent)
        root.style.setProperty('--accent-soft', `${accent}2e`)
      }
    })
    .catch(() => undefined)
  return ui
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text) e.textContent = text
  return e
}

/** Only real clicks by the user count (the page can't press our buttons). */
function onTrustedClick(button: HTMLElement, fn: () => void): void {
  button.addEventListener('click', (e) => {
    if (!e.isTrusted) return
    e.stopPropagation()
    fn()
  })
}

export interface BoxAction {
  label: string
  primary?: boolean
  run: () => void
}

export interface Box {
  setTitle: (title: string) => void
  setQuote: (text: string) => void
  setMarkdown: (markdown: string) => void
  setText: (text: string) => void
  setWaiting: (text: string) => void
  setError: (text: string) => void
  setActions: (actions: BoxAction[]) => void
  close: () => void
  element: HTMLElement
}

let openBox: Box | null = null

/** The floating box, next to `anchor` (a rect in the viewport). One at a time. */
export function showBox(anchor: DOMRect, title: string, onClose?: () => void): Box {
  openBox?.close()
  const { root } = getUi()
  const box = el('div', 'box')
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-label', title)
  const head = el('div', 'head')
  const titleEl = el('div', 'title', title)
  const close = el('button', 'icon', '×')
  close.setAttribute('aria-label', 'Close')
  head.append(el('div', 'logo'), titleEl, close)
  const body = el('div', 'body')
  const quote = el('blockquote', 'quote')
  quote.hidden = true
  const content = el('div', 'md')
  body.append(quote, content)
  const foot = el('div', 'foot')
  foot.hidden = true
  box.append(head, body, foot)
  root.append(box)

  // Below the selection if there is room, else above; inside the viewport; scrolls with the page.
  const width = Math.min(420, window.innerWidth - 24)
  const left = Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12)) + window.scrollX
  const below = anchor.bottom + 8
  const top = (below + 240 < window.innerHeight ? below : Math.max(12, anchor.top - 8 - Math.min(window.innerHeight * 0.6, 520))) + window.scrollY
  box.style.left = `${left}px`
  box.style.top = `${top}px`

  // Drag by the header.
  head.addEventListener('pointerdown', (e) => {
    if (!e.isTrusted || (e.target as HTMLElement).closest('button')) return
    const startX = e.clientX
    const startY = e.clientY
    const origin = { left: parseFloat(box.style.left), top: parseFloat(box.style.top) }
    head.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      box.style.left = `${origin.left + ev.clientX - startX}px`
      box.style.top = `${origin.top + ev.clientY - startY}px`
    }
    const up = () => {
      head.removeEventListener('pointermove', move)
      head.removeEventListener('pointerup', up)
    }
    head.addEventListener('pointermove', move)
    head.addEventListener('pointerup', up)
  })

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') api.close()
  }
  const onOutside = (e: PointerEvent) => {
    if (!e.composedPath().includes(box)) api.close()
  }
  document.addEventListener('keydown', onKey, true)
  // Next tick: the click that opened the menu isn't "outside".
  setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0)

  content.addEventListener('click', (e) => {
    const button = (e.target as HTMLElement).closest('.copy-code')
    if (!button || !e.isTrusted) return
    const code = button.closest('.code')?.querySelector('pre')?.innerText ?? ''
    void navigator.clipboard.writeText(code)
    button.textContent = 'Copied'
  })

  let closed = false
  const api: Box = {
    element: box,
    setTitle: (t) => {
      titleEl.textContent = t
    },
    setQuote: (t) => {
      quote.textContent = t
      quote.hidden = !t
    },
    setMarkdown: (md) => {
      content.className = 'md'
      content.innerHTML = renderMarkdown(md)
    },
    setText: (t) => {
      content.className = 'md'
      content.textContent = t
      content.style.whiteSpace = 'pre-wrap'
    },
    setWaiting: (t) => {
      content.className = 'muted dots'
      content.textContent = t
    },
    setError: (t) => {
      content.className = 'error'
      content.textContent = t
    },
    setActions: (actions) => {
      foot.replaceChildren(
        ...actions.map((a) => {
          const b = el('button', a.primary ? 'btn primary' : 'btn', a.label)
          onTrustedClick(b, a.run)
          return b
        }),
      )
      foot.hidden = actions.length === 0
    },
    close: () => {
      if (closed) return
      closed = true
      box.remove()
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onOutside, true)
      if (openBox === api) openBox = null
      onClose?.()
    },
  }
  onTrustedClick(close, api.close)
  openBox = api
  return api
}

let popover: HTMLElement | null = null

/** The original text over a translated passage, with "Restore". */
export function showOriginal(anchor: DOMRect, original: string, onRestore: () => void): void {
  hideOriginal()
  const { root } = getUi()
  const pop = el('div', 'pop')
  pop.setAttribute('role', 'tooltip')
  pop.append(el('div', 'label', 'Original'), el('div', 'orig', original))
  const actions = el('div', 'actions')
  const close = el('button', 'btn', 'Close')
  onTrustedClick(close, () => hideOriginal())
  const restore = el('button', 'btn primary', 'Restore original')
  onTrustedClick(restore, () => {
    onRestore()
    hideOriginal()
  })
  actions.append(close, restore)
  pop.append(actions)
  const width = Math.min(380, window.innerWidth - 24)
  pop.style.left = `${Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12)) + window.scrollX}px`
  pop.style.top = `${anchor.bottom + 6 + window.scrollY}px`
  pop.addEventListener('pointerleave', () => hideOriginal())
  root.append(pop)
  popover = pop
  // Below the block if it fits, else above it (a block at the bottom of the window).
  const height = pop.getBoundingClientRect().height
  if (anchor.bottom + 6 + height > window.innerHeight && anchor.top - 6 - height > 0) {
    pop.style.top = `${anchor.top - 6 - height + window.scrollY}px`
  }
}

export function hideOriginal(): void {
  popover?.remove()
  popover = null
}

export function isOverPopover(e: Event): boolean {
  return popover !== null && e.composedPath().includes(popover)
}

let toastEl: HTMLElement | null = null

/** A short message at the bottom right, with optional buttons. */
export function toast(text: string, actions: BoxAction[] = [], ms = 0): void {
  toastEl?.remove()
  const { root } = getUi()
  const t = el('div', 'toast')
  t.setAttribute('role', 'status')
  t.append(el('span', '', text))
  for (const a of actions) {
    const b = el('button', a.primary ? 'btn primary' : 'btn', a.label)
    onTrustedClick(b, a.run)
    t.append(b)
  }
  root.append(t)
  toastEl = t
  if (ms) setTimeout(() => t === toastEl && hideToast(), ms)
}

export function hideToast(): void {
  toastEl?.remove()
  toastEl = null
}
