/**
 * The selection tool. Drawing a loop chooses what it goes round; a tap chooses the item
 * under it. Dragging inside the selection moves it, a corner handle resizes it, and
 * dragging an item that isn't chosen chooses and moves it at once.
 */
import type { SketchItem } from '../../model'
import { containsPoint, IDENTITY, isIdentity, topItemAt, transformItem, transformRect, type Rect, type Transform } from '../geometry'
import { handleAt, resizeTransform, selectInLasso, selectionBounds, selectionFrame, type Handle } from '../lasso'
import { drawLasso, drawSelectionBox } from '../overlay'
import { drawItem, type Ctx } from '../render'
import type { SketchTheme } from '../palette'
import type { BeginTool, ToolHost, ToolPoint, ToolSession } from './types'

/** How close (screen px) a tap must be to an item to choose it. */
const TAP_REACH = 6

/** The items with the chosen ones moved and scaled by `t`. */
export function applyToSelection(items: readonly SketchItem[], ids: ReadonlySet<string>, t: Transform): SketchItem[] {
  return items.map((item) => (ids.has(item.id) ? transformItem(item, t) : item))
}

function transformSession(host: ToolHost, ids: ReadonlySet<string>, frame: Rect, toTransform: (p: ToolPoint) => Transform): ToolSession {
  const chosen = host.data.items.filter((item) => ids.has(item.id))
  let t = IDENTITY
  host.hide(ids)
  const finish = () => host.hide(null)
  return {
    move(points) {
      t = toTransform(points[points.length - 1])
    },
    end(p) {
      t = toTransform(p)
      finish()
      if (!isIdentity(t)) host.commit(applyToSelection(host.data.items, ids, t))
    },
    cancel: finish,
    draw(ctx: Ctx, theme: SketchTheme, zoom: number) {
      ctx.save()
      // The same mapping as transformItem: p' = o + (p - o) · s + d.
      ctx.transform(t.scale, 0, 0, t.scale, t.ox - t.ox * t.scale + t.dx, t.oy - t.oy * t.scale + t.dy)
      for (const item of chosen) drawItem(ctx, item, theme)
      ctx.restore()
      drawSelectionBox(ctx, transformRect(frame, t), theme, zoom)
    },
  }
}

function moveSession(host: ToolHost, ids: ReadonlySet<string>, frame: Rect, start: ToolPoint): ToolSession {
  return transformSession(host, ids, frame, (p) => ({ dx: p.x - start.x, dy: p.y - start.y, scale: 1, ox: 0, oy: 0 }))
}

function resizeSession(host: ToolHost, ids: ReadonlySet<string>, frame: Rect, handle: Handle): ToolSession {
  return transformSession(host, ids, frame, (p) => resizeTransform(frame, handle, p))
}

function lassoSession(host: ToolHost, start: ToolPoint): ToolSession {
  const poly: number[] = [start.x, start.y]
  let travelled = 0
  const add = (p: ToolPoint) => {
    const n = poly.length
    travelled += Math.hypot(p.x - poly[n - 2], p.y - poly[n - 1])
    poly.push(p.x, p.y)
  }
  return {
    move: (points) => points.forEach(add),
    end(p) {
      add(p)
      if (travelled * host.zoom < TAP_REACH) {
        const hit = topItemAt(host.data.items, p.x, p.y, TAP_REACH / host.zoom)
        host.select(hit ? [hit.id] : [])
      } else {
        host.select(selectInLasso(host.data.items, poly))
      }
    },
    cancel: () => {},
    draw: (ctx, theme, zoom) => drawLasso(ctx, poly, theme, zoom),
  }
}

export const selectTool: BeginTool = (host, p) => {
  const box = selectionBounds(host.data.items, host.selection)
  if (box) {
    const frame = selectionFrame(box, host.zoom)
    const handle = handleAt(frame, p.x, p.y, host.zoom)
    if (handle) return resizeSession(host, host.selection, frame, handle)
    if (containsPoint(frame, p.x, p.y)) return moveSession(host, host.selection, frame, p)
  }
  const hit = topItemAt(host.data.items, p.x, p.y, TAP_REACH / host.zoom)
  if (hit) {
    const ids = new Set([hit.id])
    host.select(ids)
    return moveSession(host, ids, selectionFrame(selectionBounds([hit], ids)!, host.zoom), p)
  }
  host.select([])
  return lassoSession(host, p)
}
