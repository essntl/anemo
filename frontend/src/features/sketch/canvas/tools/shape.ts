/** Lines, arrows, rectangles and ellipses: drag from one corner (or end) to the other. */
import { clampWidth, newItemId, roundCoord, type Shape, type ShapeKind } from '../../model'
import { drawShape } from '../render'
import type { BeginTool, ToolPoint } from './types'

/**
 * Where the second corner goes with Shift held: a square box for a rectangle or an
 * ellipse, a direction in 45° steps (same length) for a line or an arrow.
 */
export function constrainEnd(kind: ShapeKind, x1: number, y1: number, x2: number, y2: number): { x: number; y: number } {
  const dx = x2 - x1, dy = y2 - y1
  if (kind === 'rect' || kind === 'ellipse') {
    const side = Math.max(Math.abs(dx), Math.abs(dy))
    return { x: x1 + side * (dx < 0 ? -1 : 1), y: y1 + side * (dy < 0 ? -1 : 1) }
  }
  const length = Math.hypot(dx, dy)
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
  // Rounded so that horizontal and vertical lines come out exact.
  return { x: x1 + Math.round(Math.cos(angle) * length * 1000) / 1000, y: y1 + Math.round(Math.sin(angle) * length * 1000) / 1000 }
}

/** The shape from the starting point to `p`; null while it is too small to keep. */
export function shapeBetween(kind: ShapeKind, start: ToolPoint, p: ToolPoint, color: string, width: number, zoom: number): Shape | null {
  const end = p.shift ? constrainEnd(kind, start.x, start.y, p.x, p.y) : p
  const min = 2 / zoom
  const tooSmall = kind === 'line' || kind === 'arrow'
    ? Math.hypot(end.x - start.x, end.y - start.y) < min
    : Math.abs(end.x - start.x) < min && Math.abs(end.y - start.y) < min
  if (tooSmall) return null
  return {
    type: kind, id: newItemId(), color, width: clampWidth(width),
    x1: roundCoord(start.x), y1: roundCoord(start.y), x2: roundCoord(end.x), y2: roundCoord(end.y),
  }
}

export function shapeTool(kind: ShapeKind): BeginTool {
  return (host, start) => {
    let current: Shape | null = null
    const update = (p: ToolPoint) => {
      current = shapeBetween(kind, start, p, host.color, host.width, host.zoom)
    }
    return {
      move: (points) => update(points[points.length - 1]),
      end(p) {
        update(p)
        if (current) host.commit([...host.data.items, current])
      },
      cancel: () => {},
      draw: (ctx, theme) => {
        if (current) drawShape(ctx, current, theme)
      },
    }
  }
}
