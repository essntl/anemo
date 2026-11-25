/** The pen and the highlighter: a freehand stroke, thinned out and saved when the pointer lifts. */
import { clampWidth, newItemId, type Stroke } from '../../model'
import { prepareStrokePoints } from '../limits'
import { drawLiveStroke } from '../render'
import type { BeginTool, ToolPoint } from './types'

/** How far (sheet units) a thinned-out point may stray: 0.4 at 100 % and below, finer when zoomed in. */
export const thinningTolerance = (zoom: number): number => 0.4 / Math.max(1, zoom)

export function freehandTool(tool: Stroke['tool']): BeginTool {
  return (host, first) => {
    const { color } = host
    const width = clampWidth(host.width)
    // The highlighter is drawn without pressure: a steady 0.5 also thins out best.
    const pressureOf = (p: ToolPoint) => (tool === 'highlighter' ? 0.5 : p.pressure)
    const points: number[] = [first.x, first.y, pressureOf(first)]
    const minStep = 0.3 / host.zoom
    const add = (p: ToolPoint) => {
      const n = points.length
      if (Math.hypot(p.x - points[n - 3], p.y - points[n - 2]) < minStep) {
        points[n - 1] = Math.max(points[n - 1], pressureOf(p))
        return
      }
      points.push(p.x, p.y, pressureOf(p))
    }
    return {
      move: (moved) => moved.forEach(add),
      end(last) {
        add(last)
        const parts = prepareStrokePoints(points, thinningTolerance(host.zoom))
        if (!parts.length) return
        const strokes: Stroke[] = parts.map((part) => ({ type: 'stroke', id: newItemId(), tool, color, width, points: part }))
        host.commit([...host.data.items, ...strokes])
      },
      cancel: () => {},
      draw: (ctx, theme) => drawLiveStroke(ctx, tool, width, color, points, theme),
    }
  }
}
