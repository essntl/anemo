/**
 * The pure decisions of pointer input: which pointer draws and which moves the view
 * (palm rejection), the pressure of a point, and the maths of pinch and wheel gestures.
 */
import type { Point } from './geometry'
import { clampZoom, zoomAt, type Viewport } from './viewport'

export type PointerKind = 'mouse' | 'pen' | 'touch'

/**
 * Whether a finger draws. `setting` is the "Draw with finger" choice (null: not chosen).
 * Not chosen: fingers draw until a pen has been seen; from then on only the pen draws and
 * a finger (or a palm resting on the screen) moves the view.
 */
export const fingerDraws = (penSeen: boolean, setting: boolean | null): boolean => setting ?? !penSeen

export type PointerRole = 'draw' | 'pan' | 'ignore'

export interface PointerDecision {
  pointerType: string
  /** MouseEvent.button: 0 main, 1 middle, 2 right; -1 none. */
  button: number
  penSeen: boolean
  fingerSetting: boolean | null
  /** The hand tool is chosen, or Space is held. */
  panning: boolean
  readOnly: boolean
}

/** What a pointer that just went down does. */
export function pointerRole(d: PointerDecision): PointerRole {
  if (d.button === 2 || d.button > 4) return 'ignore'
  if (d.readOnly || d.panning || d.button === 1) return 'pan'
  if (d.pointerType === 'touch') return fingerDraws(d.penSeen, d.fingerSetting) ? 'draw' : 'pan'
  return 'draw'
}

export interface RawPressure {
  pointerType: string
  pressure: number
  tiltX?: number
  tiltY?: number
}

/**
 * The pressure of a point, 0–1. A mouse or a finger has none worth reading (browsers say
 * 0 or 0.5), so it is a steady 0.5. A pen that says 0 (it does on its first contact)
 * keeps the pressure before it. A pen held flat draws a little heavier, like a pencil.
 */
export function inkPressure(e: RawPressure, previous: number | null): number {
  if (e.pointerType !== 'pen') return 0.5
  if (!(e.pressure > 0)) return previous ?? 0.5
  const tilt = Math.min(90, Math.hypot(e.tiltX ?? 0, e.tiltY ?? 0)) / 90
  return Math.min(1, e.pressure * (1 + 0.25 * tilt))
}

export interface PinchStart {
  view: Viewport
  a: Point
  b: Point
}

/**
 * The view while two fingers move: it zooms by how much farther apart they are than at
 * the start, and the sheet point under their midpoint follows the midpoint.
 */
export function pinchViewport(start: PinchStart, a: Point, b: Point): Viewport {
  const d0 = Math.max(1, Math.hypot(start.b.x - start.a.x, start.b.y - start.a.y))
  const d1 = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y))
  const zoom = clampZoom(start.view.zoom * (d1 / d0))
  const m0 = { x: (start.a.x + start.b.x) / 2, y: (start.a.y + start.b.y) / 2 }
  const m1 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  // The sheet point under the starting midpoint.
  const sx = (m0.x - start.view.x) / start.view.zoom
  const sy = (m0.y - start.view.y) / start.view.zoom
  return { zoom, x: m1.x - sx * zoom, y: m1.y - sy * zoom }
}

export interface WheelInput {
  deltaX: number
  deltaY: number
  /** 0 pixels, 1 lines, 2 pages. */
  deltaMode: number
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

const LINE = 16

/**
 * The view after a wheel turn at (sx, sy): with Ctrl or ⌘ (and a trackpad pinch, which
 * browsers report as a wheel with Ctrl) it zooms at the cursor; otherwise it scrolls.
 */
export function wheelViewport(v: Viewport, e: WheelInput, sx: number, sy: number, pageHeight = 800): Viewport {
  const unit = e.deltaMode === 1 ? LINE : e.deltaMode === 2 ? pageHeight : 1
  let dx = e.deltaX * unit
  let dy = e.deltaY * unit
  if (e.ctrlKey || e.metaKey) {
    const step = Math.max(-60, Math.min(60, dy))
    return zoomAt(v, Math.exp(-step * 0.01), sx, sy)
  }
  // Shift + wheel scrolls sideways (where the browser hasn't already turned it).
  if (e.shiftKey && dx === 0) [dx, dy] = [dy, 0]
  return { ...v, x: v.x - dx, y: v.y - dy }
}
