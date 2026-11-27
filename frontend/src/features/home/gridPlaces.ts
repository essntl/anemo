/**
 * Home's free grid (Settings > Appearance > Full width): widgets sit anywhere on a grid
 * of GRID_COLS columns and short rows, at the place and size they were given. The place
 * is saved with the widget (`grid` in the `home` section's layout).
 *
 * A widget that was never placed on the grid (Home not yet arranged in full width, or a
 * widget added since) gets its place from the usual slots: the slot grid is laid out as
 * the browser would (three columns, in order) and scaled up, so turning full width on
 * doesn't move anything. A hidden widget keeps its place for when it comes back.
 *
 * Narrower windows show fewer columns (`reflow`): places are scaled down and widgets that
 * would then overlap move down. A widget that hides itself while the page is not being
 * edited ("Needs you" when empty) leaves no hole: what is right under it moves up into
 * its space (`closeHoles`), but never into a gap you left on purpose.
 */
import type { GridPlace, WidgetId, WidgetLayout } from './layout'

export type Place = GridPlace

export const GRID_COLS = 12
/** Columns and rows per slot of the usual grid (3 columns; rows of 9.5rem). */
const SLOT_COLS = 4
const SLOT_ROWS = 2
export const MIN_W = 2
export const MIN_H = 2
export const MAX_H = 12
/** The deepest row a widget may start on (the server's limit). */
const MAX_Y = 200

export type Places = Map<WidgetId, Place>

const overlaps = (a: Place, b: Place) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** A place kept on a grid of `cols` columns and within the size limits. */
export function clampPlace(p: Place, cols = GRID_COLS): Place {
  const minW = Math.min(MIN_W, cols)
  const w = Math.max(minW, Math.min(cols, Math.round(p.w)))
  const h = Math.max(MIN_H, Math.min(MAX_H, Math.round(p.h)))
  const x = Math.max(0, Math.min(cols - w, Math.round(p.x)))
  const y = Math.max(0, Math.min(MAX_Y, Math.round(p.y)))
  return { x, y, w, h }
}

/**
 * Where the browser puts items of these spans in a grid of `cols` columns, in order
 * (CSS grid's auto-placement: each item goes to the first spot after the previous one
 * where it fits).
 */
export function autoPlace(items: { w: number; h: number }[], cols: number): Place[] {
  const taken: Place[] = []
  let row = 0
  let col = 0
  for (const item of items) {
    const w = Math.min(item.w, cols)
    const h = item.h
    for (;;) {
      if (col + w > cols) {
        row += 1
        col = 0
        continue
      }
      const spot = { x: col, y: row, w, h }
      if (!taken.some((t) => overlaps(t, spot))) {
        taken.push(spot)
        col += w
        break
      }
      col += 1
    }
  }
  return taken
}

/** The first spot, from the top, where a widget of this size fits among `others`. */
export function firstFree(size: { w: number; h: number }, others: Place[], cols = GRID_COLS): Place {
  const w = Math.min(size.w, cols)
  for (let y = 0; y <= MAX_Y; y++) {
    for (let x = 0; x + w <= cols; x++) {
      const spot = { x, y, w, h: size.h }
      if (!others.some((o) => overlaps(o, spot))) return spot
    }
  }
  return { x: 0, y: MAX_Y, w, h: size.h }
}

/**
 * Every widget's place on the 12-column grid: its saved one, else where its slot is.
 * Widgets left out by `skip` (hidden ones) are not laid out but keep a saved place.
 * `later`: widgets the usual grid doesn't show right now ("Needs you" while empty); they
 * are left out of the slots, as the page shows them, and get the first free spot after.
 */
export function placesOf(
  layout: WidgetLayout[],
  skip: (item: WidgetLayout) => boolean = (w) => !!w.hidden,
  later: (item: WidgetLayout) => boolean = () => false,
): Places {
  const places: Places = new Map()
  const shown = layout.filter((w) => !skip(w))
  // When no widget was placed yet, they take their slots as the usual grid shows them:
  // exactly the page as it was.
  const unplaced = shown.filter((w) => !w.grid)
  if (unplaced.length === shown.length) {
    const slotted = shown.filter((w) => !later(w))
    autoPlace(slotted, 3).forEach((p, i) => {
      places.set(slotted[i].id, { x: p.x * SLOT_COLS, y: p.y * SLOT_ROWS, w: p.w * SLOT_COLS, h: p.h * SLOT_ROWS })
    })
    for (const w of shown.filter(later)) {
      places.set(w.id, firstFree({ w: Math.min(w.w, 3) * SLOT_COLS, h: w.h * SLOT_ROWS }, [...places.values()]))
    }
  } else {
    for (const w of shown) if (w.grid) places.set(w.id, clampPlace(w.grid))
    // One added since the grid was arranged: the first free spot of its slot size.
    for (const w of unplaced) {
      places.set(w.id, firstFree({ w: Math.min(w.w, 3) * SLOT_COLS, h: w.h * SLOT_ROWS }, [...places.values()]))
    }
  }
  for (const w of layout) if (skip(w) && w.grid) places.set(w.id, clampPlace(w.grid))
  return places
}

/**
 * `id` at `place`; widgets it now covers move down, and the ones they cover after them,
 * so nothing overlaps. Only the widgets in `active` take part (the shown ones).
 */
export function moveTo(places: Places, active: WidgetId[], id: WidgetId, place: Place, cols = GRID_COLS): Places {
  const next: Places = new Map(places)
  next.set(id, clampPlace(place, cols))
  const fixed = [id]
  // Push down whatever overlaps what is already settled, top to bottom.
  const queue = active.filter((a) => a !== id).sort((a, b) => next.get(a)!.y - next.get(b)!.y || next.get(a)!.x - next.get(b)!.x)
  for (const other of queue) {
    const p = next.get(other)
    if (!p) continue
    let y = p.y
    for (;;) {
      const spot = { ...p, y }
      const hit = fixed.map((f) => next.get(f)!).find((f) => overlaps(f, spot))
      if (!hit) break
      y = hit.y + hit.h
    }
    next.set(other, { ...p, y })
    fixed.push(other)
  }
  return next
}

/**
 * The places on a grid of `cols` columns (a narrower window): scaled down from 12, and
 * moved down where they would overlap, top to bottom.
 */
export function reflow(places: Places, active: WidgetId[], cols: number): Places {
  if (cols >= GRID_COLS) return new Map(active.filter((id) => places.has(id)).map((id) => [id, places.get(id)!]))
  const scale = cols / GRID_COLS
  const order = active.filter((id) => places.has(id)).sort((a, b) => places.get(a)!.y - places.get(b)!.y || places.get(a)!.x - places.get(b)!.x)
  const out: Places = new Map()
  for (const id of order) {
    const p = places.get(id)!
    const w = Math.max(Math.min(MIN_W, cols), Math.min(cols, Math.round(p.w * scale)))
    const x = Math.max(0, Math.min(cols - w, Math.round(p.x * scale)))
    let spot = { x, y: p.y, w, h: p.h }
    for (;;) {
      const hit = [...out.values()].find((o) => overlaps(o, spot))
      if (!hit) break
      spot = { ...spot, y: hit.y + hit.h }
    }
    out.set(id, spot)
  }
  return out
}

/** A place on a grid of `cols` columns back on the 12-column one (what is saved). */
export function toFullGrid(p: Place, cols: number): Place {
  if (cols >= GRID_COLS) return p
  const scale = GRID_COLS / cols
  return clampPlace({ x: p.x * scale, y: p.y, w: p.w * scale, h: p.h })
}

/**
 * Widgets under one that hides itself (`gone`) move up into the space it leaves, as far
 * as that space goes: never into a gap that was there anyway.
 */
export function closeHoles(places: Places, shown: WidgetId[], gone: WidgetId[]): Places {
  const out: Places = new Map(shown.filter((id) => places.has(id)).map((id) => [id, places.get(id)!]))
  const key = (x: number, y: number) => `${x},${y}`
  // The cells that are free to move into: the hidden widgets' space, and what a widget
  // leaves behind as it moves up.
  const free = new Set<string>()
  for (const id of gone) {
    const h = places.get(id)
    if (!h) continue
    for (let x = h.x; x < h.x + h.w; x++) for (let y = h.y; y < h.y + h.h; y++) free.add(key(x, y))
  }
  if (!free.size) return out
  for (const p of out.values()) {
    for (let x = p.x; x < p.x + p.w; x++) for (let y = p.y; y < p.y + p.h; y++) free.delete(key(x, y))
  }
  const order = [...out.keys()].sort((a, b) => out.get(a)!.y - out.get(b)!.y)
  for (const id of order) {
    let p = out.get(id)!
    while (p.y > 0) {
      const row = p.y - 1
      let fits = true
      for (let x = p.x; x < p.x + p.w; x++) if (!free.has(key(x, row))) fits = false
      if (!fits) break
      for (let x = p.x; x < p.x + p.w; x++) {
        free.delete(key(x, row))
        free.add(key(x, p.y + p.h - 1))
      }
      p = { ...p, y: row }
      out.set(id, p)
    }
  }
  return out
}

/** The saved layout with every shown widget's place written to it. */
export function withPlaces(layout: WidgetLayout[], places: Places): WidgetLayout[] {
  return layout.map((w) => {
    const p = places.get(w.id)
    return p ? { ...w, grid: { ...p } } : w
  })
}

/** The rows the grid needs (the lowest widget's bottom). */
export function rowsUsed(places: Iterable<Place>): number {
  let rows = 0
  for (const p of places) rows = Math.max(rows, p.y + p.h)
  return rows
}
