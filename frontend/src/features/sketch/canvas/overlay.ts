/**
 * What the top canvas draws over the drawing: the lasso being drawn, the selection box
 * with its handles, and the eraser's circle. The context is in sheet units (applyView),
 * so screen-pixel sizes are divided by the zoom.
 */
import type { Rect } from './geometry'
import { HANDLE_SIZE, handlePoints } from './lasso'
import type { SketchTheme } from './palette'
import type { Ctx } from './render'

export function drawLasso(ctx: Ctx, poly: readonly number[], theme: SketchTheme, zoom: number): void {
  if (poly.length < 4) return
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(poly[0], poly[1])
  for (let i = 2; i < poly.length; i += 2) ctx.lineTo(poly[i], poly[i + 1])
  ctx.closePath()
  ctx.globalAlpha = 0.08
  ctx.fillStyle = theme.selection
  ctx.fill()
  ctx.globalAlpha = 1
  ctx.strokeStyle = theme.selection
  ctx.lineWidth = 1.5 / zoom
  ctx.setLineDash([5 / zoom, 4 / zoom])
  ctx.stroke()
  ctx.restore()
}

/** `frame` is the selection's frame (selectionFrame), the handles at its corners. */
export function drawSelectionBox(ctx: Ctx, frame: Rect, theme: SketchTheme, zoom: number): void {
  ctx.save()
  ctx.strokeStyle = theme.selection
  ctx.lineWidth = 1.5 / zoom
  ctx.setLineDash([])
  ctx.strokeRect(frame.minX, frame.minY, frame.maxX - frame.minX, frame.maxY - frame.minY)
  const size = HANDLE_SIZE / zoom
  ctx.fillStyle = theme.paper
  for (const p of Object.values(handlePoints(frame))) {
    ctx.fillRect(p.x - size / 2, p.y - size / 2, size, size)
    ctx.strokeRect(p.x - size / 2, p.y - size / 2, size, size)
  }
  ctx.restore()
}

export function drawEraserCursor(ctx: Ctx, x: number, y: number, r: number, theme: SketchTheme, zoom: number): void {
  ctx.save()
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.globalAlpha = 0.6
  ctx.strokeStyle = theme.ink
  ctx.lineWidth = 1 / zoom
  ctx.stroke()
  ctx.restore()
}
