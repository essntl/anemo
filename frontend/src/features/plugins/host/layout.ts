/**
 * Where things are on Anemo's screen, for plugin frames (`layout.get`, the `layout.changed`
 * event): the viewport's size, the route, and the rectangles of a few named places
 * ("anchors"), all in CSS pixels of the top page's viewport.
 *
 * An anchor is any element of the app marked `data-plugin-anchor="<name>"` (the message box
 * is `composer`, the sidebar `sidebar`). Adding one is adding that attribute: the host
 * measures whatever is marked and on screen. Names are part of the plugin contract, so an
 * anchor is only ever added, never renamed. When several elements have the same name, the
 * first one that is shown wins (e.g. the phone menu and the desktop sidebar).
 *
 * One tracker serves every frame: it starts watching when the first frame subscribes and
 * stops with the last. Changes are measured once per animation frame at most and reported
 * only when something really changed.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface LayoutInfo {
  viewport: { width: number; height: number }
  anchors: Record<string, Rect>
  route: string
}

export const ANCHOR_ATTRIBUTE = 'data-plugin-anchor'
/** The anchor names a plugin can rely on (the contract lists them). */
export const ANCHORS = ['composer', 'sidebar'] as const

const round = (n: number) => Math.round(n * 10) / 10

/** The layout as it is now. */
export function measureLayout(doc: Document = document): LayoutInfo {
  const anchors: Record<string, Rect> = {}
  doc.querySelectorAll<HTMLElement>(`[${ANCHOR_ATTRIBUTE}]`).forEach((el) => {
    const name = el.getAttribute(ANCHOR_ATTRIBUTE) ?? ''
    if (!(ANCHORS as readonly string[]).includes(name) || anchors[name]) return
    const r = el.getBoundingClientRect()
    // display: none, or not laid out at all: not on screen.
    if (r.width <= 0 || r.height <= 0) return
    anchors[name] = { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) }
  })
  const view = doc.defaultView
  return {
    viewport: { width: view?.innerWidth ?? 0, height: view?.innerHeight ?? 0 },
    anchors,
    route: view?.location.pathname ?? '/',
  }
}

type Listener = (layout: LayoutInfo) => void

const listeners = new Set<Listener>()
let last = ''
let frame = 0
let stop: (() => void) | null = null

function check() {
  frame = 0
  const layout = measureLayout()
  const text = JSON.stringify(layout)
  if (text === last) return
  last = text
  listeners.forEach((fn) => fn(layout))
}

/** Something may have moved: measure again on the next animation frame (coalesced). */
export function pokeLayout(): void {
  if (!listeners.size || frame) return
  frame = requestAnimationFrame(check)
}

function start(): () => void {
  last = JSON.stringify(measureLayout())
  const watched = new Set<Element>()
  // Anchors change size (the message box grows, the sidebar folds) …
  const sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => pokeLayout())
  const watchAnchors = () => {
    if (!sizes) return
    const now = new Set(document.querySelectorAll(`[${ANCHOR_ATTRIBUTE}]`))
    watched.forEach((el) => !now.has(el) && (sizes.unobserve(el), watched.delete(el)))
    now.forEach((el) => !watched.has(el) && (sizes.observe(el), watched.add(el)))
  }
  watchAnchors()
  // … appear and disappear (a page with a message box opens, the sidebar is swapped for its rail).
  const tree = new MutationObserver(() => {
    watchAnchors()
    pokeLayout()
  })
  tree.observe(document.body, { childList: true, subtree: true })
  window.addEventListener('resize', pokeLayout)
  return () => {
    tree.disconnect()
    sizes?.disconnect()
    window.removeEventListener('resize', pokeLayout)
    if (frame) cancelAnimationFrame(frame)
    frame = 0
  }
}

/** Calls `fn` with every change of the layout. Returns a function that stops listening. */
export function watchLayout(fn: Listener): () => void {
  listeners.add(fn)
  if (!stop) stop = start()
  return () => {
    listeners.delete(fn)
    if (!listeners.size && stop) {
      stop()
      stop = null
    }
  }
}
