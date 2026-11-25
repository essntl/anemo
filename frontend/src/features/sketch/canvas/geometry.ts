/**
 * Pure geometry of sketch items: bounds, hit tests, lasso containment, moving and
 * scaling, and thinning out the points of a stroke. No canvas, no DOM.
 */
import { clampFontSize, clampWidth, isStroke, isText, LIMITS, roundCoord, type SketchItem } from '../model'
import { layoutText } from './text'

export interface Rect {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface Point {
  x: number
  y: number
}

export const rectWidth = (r: Rect): number => r.maxX - r.minX
export const rectHeight = (r: Rect): number => r.maxY - r.minY

export function rectFromPoints(ax: number, ay: number, bx: number, by: number): Rect {
  return { minX: Math.min(ax, bx), minY: Math.min(ay, by), maxX: Math.max(ax, bx), maxY: Math.max(ay, by) }
}

export function unionRects(rects: Iterable<Rect>): Rect | null {
  let out: Rect | null = null
  for (const r of rects) {
    out = out
      ? { minX: Math.min(out.minX, r.minX), minY: Math.min(out.minY, r.minY), maxX: Math.max(out.maxX, r.maxX), maxY: Math.max(out.maxY, r.maxY) }
      : { ...r }
  }
  return out
}

export const rectsIntersect = (a: Rect, b: Rect): boolean => a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY

export const inflate = (r: Rect, by: number): Rect => ({ minX: r.minX - by, minY: r.minY - by, maxX: r.maxX + by, maxY: r.maxY + by })

export const containsPoint = (r: Rect, x: number, y: number): boolean => x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY

// Items never change in place (every edit makes a new object), so their bounds can be kept by identity.
const boundsCache = new WeakMap<SketchItem, Rect>()

function computeBounds(item: SketchItem): Rect {
  if (isStroke(item)) {
    const p = item.points
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i], y = p[i + 1]
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    return inflate({ minX, minY, maxX, maxY }, item.width / 2)
  }
  if (isText(item)) {
    const layout = layoutText(item)
    return { minX: item.x, minY: item.y, maxX: item.x + Math.max(layout.width, item.size * 0.5), maxY: item.y + layout.height }
  }
  const r = rectFromPoints(item.x1, item.y1, item.x2, item.y2)
  // An arrow's head reaches a little past its line.
  return inflate(r, item.width / 2 + (item.type === 'arrow' ? arrowHeadLength(item.width) : 0))
}

/** The box an item covers, line widths included. */
export function itemBounds(item: SketchItem): Rect {
  let r = boundsCache.get(item)
  if (!r) {
    r = computeBounds(item)
    boundsCache.set(item, r)
  }
  return r
}

export const itemsBounds = (items: Iterable<SketchItem>): Rect | null => unionRects([...items].map(itemBounds))

/** The length of an arrow's head for a line of this width. */
export const arrowHeadLength = (width: number): number => Math.max(10, width * 3.5)

/** The distance from (px, py) to the segment a–b. */
export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * dx - px, cy = ay + t * dy - py
  return Math.sqrt(cx * cx + cy * cy)
}

/** The distance from (px, py) to the outline of the ellipse in box `r` (a close estimate). */
function distToEllipse(px: number, py: number, r: Rect): number {
  const cx = (r.minX + r.maxX) / 2, cy = (r.minY + r.maxY) / 2
  const rx = Math.max(rectWidth(r) / 2, 0.01), ry = Math.max(rectHeight(r) / 2, 0.01)
  const nx = (px - cx) / rx, ny = (py - cy) / ry
  const k = Math.sqrt(nx * nx + ny * ny)
  if (k === 0) return Math.min(rx, ry)
  // The point of the outline on the ray from the centre through p.
  const ox = cx + (nx / k) * rx, oy = cy + (ny / k) * ry
  return Math.hypot(px - ox, py - oy)
}

/** Whether (x, y) is on the item: within `tolerance` of its line, or inside a text box. */
export function hitItem(item: SketchItem, x: number, y: number, tolerance: number): boolean {
  if (!containsPoint(inflate(itemBounds(item), tolerance), x, y)) return false
  if (isText(item)) return true
  const reach = item.width / 2 + tolerance
  if (isStroke(item)) {
    const p = item.points
    if (p.length === 3) return Math.hypot(p[0] - x, p[1] - y) <= reach
    for (let i = 3; i < p.length; i += 3) {
      if (distToSegment(x, y, p[i - 3], p[i - 2], p[i], p[i + 1]) <= reach) return true
    }
    return false
  }
  if (item.type === 'line' || item.type === 'arrow') return distToSegment(x, y, item.x1, item.y1, item.x2, item.y2) <= reach + (item.type === 'arrow' ? 2 : 0)
  const r = rectFromPoints(item.x1, item.y1, item.x2, item.y2)
  if (item.type === 'ellipse') return distToEllipse(x, y, r) <= reach
  const edges: [number, number, number, number][] = [
    [r.minX, r.minY, r.maxX, r.minY], [r.maxX, r.minY, r.maxX, r.maxY],
    [r.maxX, r.maxY, r.minX, r.maxY], [r.minX, r.maxY, r.minX, r.minY],
  ]
  return edges.some(([ax, ay, bx, by]) => distToSegment(x, y, ax, ay, bx, by) <= reach)
}

/** The topmost item at (x, y), or null. */
export function topItemAt(items: readonly SketchItem[], x: number, y: number, tolerance: number): SketchItem | null {
  for (let i = items.length - 1; i >= 0; i--) if (hitItem(items[i], x, y, tolerance)) return items[i]
  return null
}

/** Even–odd ray test: whether (x, y) is inside the polygon (flat x, y, x, y…). */
export function pointInPolygon(x: number, y: number, poly: readonly number[]): boolean {
  let inside = false
  const n = poly.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2], yi = poly[i * 2 + 1], xj = poly[j * 2], yj = poly[j * 2 + 1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Points that stand for the item when a lasso is checked against it. */
function samplePoints(item: SketchItem): number[] {
  if (isStroke(item)) {
    const out: number[] = []
    // At most ~64 samples: enough to tell, fast for long strokes.
    const step = Math.max(1, Math.floor(item.points.length / 3 / 64)) * 3
    for (let i = 0; i < item.points.length; i += step) out.push(item.points[i], item.points[i + 1])
    return out
  }
  const b = isText(item) ? itemBounds(item) : rectFromPoints(item.x1, item.y1, item.x2, item.y2)
  if (!isText(item) && (item.type === 'line' || item.type === 'arrow')) return [item.x1, item.y1, item.x2, item.y2, (item.x1 + item.x2) / 2, (item.y1 + item.y2) / 2]
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2
  if (!isText(item) && item.type === 'ellipse') return [b.minX, cy, b.maxX, cy, cx, b.minY, cx, b.maxY]
  return [b.minX, b.minY, b.maxX, b.minY, b.maxX, b.maxY, b.minX, b.maxY]
}

/** Whether the lasso (a closed polygon, flat x, y…) takes the item: three quarters of it inside. */
export function itemInLasso(item: SketchItem, poly: readonly number[], polyBounds: Rect): boolean {
  if (!rectsIntersect(itemBounds(item), polyBounds)) return false
  const s = samplePoints(item)
  let inside = 0
  for (let i = 0; i < s.length; i += 2) if (pointInPolygon(s[i], s[i + 1], poly)) inside++
  return inside >= Math.ceil((s.length / 2) * 0.75)
}

export function polygonBounds(poly: readonly number[]): Rect {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < poly.length; i += 2) {
    minX = Math.min(minX, poly[i]); maxX = Math.max(maxX, poly[i])
    minY = Math.min(minY, poly[i + 1]); maxY = Math.max(maxY, poly[i + 1])
  }
  return { minX, minY, maxX, maxY }
}

/** A move and a uniform scale around an origin: p' = origin + (p - origin) · scale + (dx, dy). */
export interface Transform {
  dx: number
  dy: number
  scale: number
  ox: number
  oy: number
}

export const IDENTITY: Transform = { dx: 0, dy: 0, scale: 1, ox: 0, oy: 0 }

export const isIdentity = (t: Transform): boolean => t.dx === 0 && t.dy === 0 && t.scale === 1

const tx = (t: Transform, x: number) => roundCoord(t.ox + (x - t.ox) * t.scale + t.dx)
const ty = (t: Transform, y: number) => roundCoord(t.oy + (y - t.oy) * t.scale + t.dy)

/** The item moved and scaled by `t` (line widths and font sizes scale too, within the limits). */
export function transformItem<T extends SketchItem>(item: T, t: Transform): T {
  if (isStroke(item)) {
    const points = item.points.slice()
    for (let i = 0; i < points.length; i += 3) {
      points[i] = tx(t, points[i])
      points[i + 1] = ty(t, points[i + 1])
    }
    return { ...item, points, width: clampWidth(item.width * t.scale) }
  }
  if (isText(item)) {
    const width = item.width ? Math.max(10, Math.min(LIMITS.coord, Math.round(item.width * t.scale * 10) / 10)) : item.width
    return { ...item, x: tx(t, item.x), y: ty(t, item.y), size: clampFontSize(item.size * t.scale), width }
  }
  return { ...item, x1: tx(t, item.x1), y1: ty(t, item.y1), x2: tx(t, item.x2), y2: ty(t, item.y2), width: clampWidth(item.width * t.scale) }
}

export function transformRect(r: Rect, t: Transform): Rect {
  const x = (v: number) => t.ox + (v - t.ox) * t.scale + t.dx
  const y = (v: number) => t.oy + (v - t.oy) * t.scale + t.dy
  return rectFromPoints(x(r.minX), y(r.minY), x(r.maxX), y(r.maxY))
}

/**
 * Thins out a stroke's points (flat x, y, pressure…) with Ramer–Douglas–Peucker: a point
 * stays when it is more than `tolerance` from the line its neighbours make, or when its
 * pressure is more than `pressureTolerance` off theirs. The first and last points always stay.
 */
export function thinPoints(points: readonly number[], tolerance = 0.4, pressureTolerance = 0.06): number[] {
  const n = points.length / 3
  if (n <= 2) return points.slice()
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1
  const stack: [number, number][] = [[0, n - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    if (b - a < 2) continue
    const ax = points[a * 3], ay = points[a * 3 + 1], ap = points[a * 3 + 2]
    const bx = points[b * 3], by = points[b * 3 + 1], bp = points[b * 3 + 2]
    const segLen = Math.hypot(bx - ax, by - ay)
    let worst = -1, worstScore = 1
    for (let i = a + 1; i < b; i++) {
      const x = points[i * 3], y = points[i * 3 + 1], p = points[i * 3 + 2]
      const d = distToSegment(x, y, ax, ay, bx, by)
      // Pressure expected here, along the chord.
      const along = segLen === 0 ? 0 : Math.hypot(x - ax, y - ay) / segLen
      const dp = Math.abs(p - (ap + (bp - ap) * Math.min(1, along)))
      const score = Math.max(d / tolerance, dp / pressureTolerance)
      if (score > worstScore) {
        worstScore = score
        worst = i
      }
    }
    if (worst >= 0) {
      keep[worst] = 1
      stack.push([a, worst], [worst, b])
    }
  }
  const out: number[] = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i * 3], points[i * 3 + 1], points[i * 3 + 2])
  return out
}
