/** The eraser: what it touches goes while you drag; the change is saved (one undo step) when it lifts. */
import type { SketchItem } from '../../model'
import { eraseAlong, eraseAt } from '../eraser'
import { drawEraserCursor } from '../overlay'
import type { BeginTool } from './types'

/** The eraser's radius in sheet units: its size is a diameter in screen pixels. */
export const eraserRadius = (size: number, zoom: number): number => size / 2 / zoom

export const eraseTool: BeginTool = (host, first) => {
  const r = eraserRadius(host.width, host.zoom)
  const original = host.data.items
  let items: readonly SketchItem[] = eraseAt(original, first.x, first.y, r, host.eraseMode)
  let last = first
  if (items !== original) host.preview(items)
  return {
    move(points) {
      const before = items
      for (const p of points) {
        items = eraseAlong(items, last.x, last.y, p.x, p.y, r, host.eraseMode)
        last = p
      }
      if (items !== before) host.preview(items)
    },
    end() {
      if (items === original) return
      if (!host.commit([...items])) host.preview(null)
    },
    cancel: () => host.preview(null),
    draw: (ctx, theme, zoom) => drawEraserCursor(ctx, last.x, last.y, r, theme, zoom),
  }
}
