/**
 * The selection: what a lasso takes, the box around the chosen items, its corner
 * handles, and the move or resize a drag on them makes.
 */
import type { SketchItem } from '../model'
import { inflate, itemBounds, itemInLasso, polygonBounds, rectHeight, rectWidth, unionRects, type Point, type Rect, type Transform } from './geometry'

/** The ids of the items the lasso (flat x, y… of the path drawn) takes. */
export function selectInLasso(items: readonly SketchItem[], poly: readonly number[]): string[] {
  if (poly.length < 6) return []
  const bounds = polygonBounds(poly)
  return items.filter((item) => itemInLasso(item, poly, bounds)).map((item) => item.id)
}

/** The box around the chosen items (null when none of them is there). */
export function selectionBounds(items: readonly SketchItem[], ids: ReadonlySet<string>): Rect | null {
  if (ids.size === 0) return null
  return unionRects(items.filter((item) => ids.has(item.id)).map(itemBounds))
}

/** The frame drawn around a selection: its box with a few screen pixels of room. Handles sit at its corners. */
export const selectionFrame = (box: Rect, zoom: number): Rect => inflate(box, 4 / zoom)

export type Handle = 'nw' | 'ne' | 'sw' | 'se'

/** The size of a handle on screen (CSS px), and how far from it a touch still takes it. */
export const HANDLE_SIZE = 10
export const HANDLE_REACH = 14

export function handlePoints(box: Rect): Record<Handle, Point> {
  return {
    nw: { x: box.minX, y: box.minY },
    ne: { x: box.maxX, y: box.minY },
    sw: { x: box.minX, y: box.maxY },
    se: { x: box.maxX, y: box.maxY },
  }
}

/** The handle at (x, y) (sheet units) at this zoom, or null. */
export function handleAt(box: Rect, x: number, y: number, zoom: number, reach = HANDLE_REACH): Handle | null {
  const r = reach / zoom
  for (const [name, p] of Object.entries(handlePoints(box)) as [Handle, Point][]) {
    if (Math.abs(p.x - x) <= r && Math.abs(p.y - y) <= r) return name
  }
  return null
}

const OPPOSITE: Record<Handle, Handle> = { nw: 'se', ne: 'sw', sw: 'ne', se: 'nw' }

/** The smallest a selection can be scaled to, in sheet units of its longer side. */
const MIN_SIDE = 4

/**
 * The resize a handle dragged from `start` to `now` makes: a uniform scale around the
 * opposite corner, measured along the box's diagonal (so the shape keeps its proportions).
 */
export function resizeTransform(box: Rect, handle: Handle, now: Point): Transform {
  const corners = handlePoints(box)
  const origin = corners[OPPOSITE[handle]]
  const corner = corners[handle]
  const dx = corner.x - origin.x, dy = corner.y - origin.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return { dx: 0, dy: 0, scale: 1, ox: origin.x, oy: origin.y }
  const projected = ((now.x - origin.x) * dx + (now.y - origin.y) * dy) / len2
  const longest = Math.max(rectWidth(box), rectHeight(box), 1)
  const scale = Math.max(MIN_SIDE / longest, projected)
  return { dx: 0, dy: 0, scale, ox: origin.x, oy: origin.y }
}
