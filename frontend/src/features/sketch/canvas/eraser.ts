/**
 * The eraser: removes whole items it touches, or (partial mode) only the parts of pen and
 * highlighter strokes under it, splitting a stroke in two where it passes through the middle.
 */
import { isStroke, newItemId, roundCoord, roundPressure, type SketchItem, type Stroke } from '../model'
import { hitItem, itemBounds, rectsIntersect, type Rect } from './geometry'

export type EraseMode = 'whole' | 'partial'

/** The parameters (0..1) where the segment a→b is inside the circle, or null when it never is. */
function insideInterval(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, r: number): [number, number] | null {
  const dx = bx - ax, dy = by - ay
  const fx = ax - cx, fy = ay - cy
  const a = dx * dx + dy * dy
  const c = fx * fx + fy * fy - r * r
  if (a === 0) return c <= 0 ? [0, 1] : null
  const b = 2 * (fx * dx + fy * dy)
  const disc = b * b - 4 * a * c
  if (disc < 0) return null
  const s = Math.sqrt(disc)
  const t0 = Math.max(0, (-b - s) / (2 * a))
  const t1 = Math.min(1, (-b + s) / (2 * a))
  return t0 <= t1 ? [t0, t1] : null
}

/**
 * The parts of a stroke outside the circle (cx, cy, r). The stroke comes back unchanged
 * (same object) when the circle misses it; an empty list when nothing of it is left.
 */
export function cutStroke(stroke: Stroke, cx: number, cy: number, r: number): Stroke[] {
  const p = stroke.points
  const reach = r + stroke.width / 2
  const n = p.length / 3
  if (n === 1) return Math.hypot(p[0] - cx, p[1] - cy) <= reach ? [] : [stroke]
  const runs: number[][] = []
  let run: number[] = []
  let touched = false
  const at = (i: number, t: number): [number, number, number] => {
    const j = i * 3, k = (i + 1) * 3
    return [roundCoord(p[j] + (p[k] - p[j]) * t), roundCoord(p[j + 1] + (p[k + 1] - p[j + 1]) * t), roundPressure(p[j + 2] + (p[k + 2] - p[j + 2]) * t)]
  }
  const firstInside = Math.hypot(p[0] - cx, p[1] - cy) <= reach
  if (!firstInside) run.push(p[0], p[1], p[2])
  for (let i = 0; i < n - 1; i++) {
    const cut = insideInterval(p[i * 3], p[i * 3 + 1], p[i * 3 + 3], p[i * 3 + 4], cx, cy, reach)
    if (!cut) {
      run.push(p[i * 3 + 3], p[i * 3 + 4], p[i * 3 + 5])
      continue
    }
    touched = true
    const [t0, t1] = cut
    if (t0 > 0) run.push(...at(i, t0))
    if (run.length) runs.push(run)
    run = []
    if (t1 < 1) {
      run.push(...at(i, t1))
      run.push(p[i * 3 + 3], p[i * 3 + 4], p[i * 3 + 5])
    }
  }
  if (run.length) runs.push(run)
  if (!touched) return [stroke]
  // A leftover shorter than the eraser's tip is a crumb: drop it.
  return runs
    .filter((r2) => r2.length >= 6 && runLength(r2) > stroke.width * 0.5)
    .map((points, i) => ({ ...stroke, id: i === 0 ? stroke.id : newItemId(), points }))
}

function runLength(points: number[]): number {
  let len = 0
  for (let i = 3; i < points.length; i += 3) len += Math.hypot(points[i] - points[i - 3], points[i + 1] - points[i - 2])
  return len
}

/**
 * The items after erasing at (x, y) with radius `r`. Returns the same array when nothing
 * was erased, so a caller can tell cheaply.
 */
export function eraseAt(items: readonly SketchItem[], x: number, y: number, r: number, mode: EraseMode): readonly SketchItem[] {
  const area: Rect = { minX: x - r, minY: y - r, maxX: x + r, maxY: y + r }
  let out: SketchItem[] | null = null
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    let replacement: SketchItem[] | null = null
    if (rectsIntersect(itemBounds(item), area)) {
      if (mode === 'partial' && isStroke(item)) {
        const parts = cutStroke(item, x, y, r)
        if (parts.length !== 1 || parts[0] !== item) replacement = parts
      } else if (hitItem(item, x, y, r)) {
        replacement = []
      }
    }
    if (replacement && !out) out = items.slice(0, i) as SketchItem[]
    if (out) {
      if (replacement) out.push(...replacement)
      else out.push(item)
    }
  }
  return out ?? items
}

/** Erases along the segment from (ax, ay) to (bx, by), so a fast swipe leaves no gaps. */
export function eraseAlong(items: readonly SketchItem[], ax: number, ay: number, bx: number, by: number, r: number, mode: EraseMode): readonly SketchItem[] {
  const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / Math.max(r * 0.75, 0.5)))
  let current = items
  for (let s = 1; s <= steps; s++) {
    const t = s / steps
    current = eraseAt(current, ax + (bx - ax) * t, ay + (by - ay) * t, r, mode)
  }
  return current
}
