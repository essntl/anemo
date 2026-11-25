/**
 * Drawing a sketch on a CanvasRenderingContext2D: the paper and its pattern, the pages,
 * and the items. The canvas (SketchCanvas) and the preview image (preview.ts) both draw
 * through here, so they look the same.
 *
 * Text is only ever drawn with fillText: what a text box holds is never treated as markup.
 */
import { getStroke } from 'perfect-freehand'
import { isStroke, isText, PAGE, pageTop, type Shape, type SketchData, type SketchItem, type Stroke, type TextBox } from '../model'
import { arrowHeadLength, itemBounds, rectsIntersect, type Rect } from './geometry'
import { resolveColor, type SketchTheme } from './palette'
import { fontFor, layoutText } from './text'
import type { Viewport } from './viewport'

/** The 2D context of a canvas element or an OffscreenCanvas. */
export type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

type Tool = Stroke['tool']

/** How a pen or highlighter line is drawn from its points (perfect-freehand). */
function freehandOptions(tool: Tool, width: number, last: boolean) {
  return tool === 'highlighter'
    ? { size: width, thinning: 0, smoothing: 0.5, streamline: 0.4, simulatePressure: false, last }
    : { size: width, thinning: 0.6, smoothing: 0.5, streamline: 0.35, simulatePressure: false, easing: (t: number) => t, last }
}

/** The outline polygon of a freehand line, from flat x, y, pressure points. */
export function strokeOutline(tool: Tool, width: number, points: readonly number[], last = true): number[][] {
  const input: number[][] = []
  for (let i = 0; i < points.length; i += 3) input.push([points[i], points[i + 1], points[i + 2]])
  return getStroke(input, freehandOptions(tool, width, last))
}

const hasPath2D = (): boolean => typeof Path2D !== 'undefined'

function outlinePath(outline: number[][]): Path2D {
  const path = new Path2D()
  traceOutline(path, outline)
  return path
}

/** Moves along the outline with quadratic curves through the midpoints (smooth, few segments). */
function traceOutline(target: Path2D | Ctx, outline: number[][]): void {
  const n = outline.length
  if (n === 0) return
  target.moveTo(outline[0][0], outline[0][1])
  for (let i = 1; i < n; i++) {
    const [x0, y0] = outline[i]
    const [x1, y1] = outline[(i + 1) % n]
    target.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2)
  }
  target.closePath()
}

// One outline per stroke, kept for as long as the stroke object lives (items never change in place).
const outlines = new WeakMap<Stroke, Path2D | number[][]>()

function cachedOutline(stroke: Stroke): Path2D | number[][] {
  let cached = outlines.get(stroke)
  if (!cached) {
    const outline = strokeOutline(stroke.tool, stroke.width, stroke.points)
    cached = hasPath2D() ? outlinePath(outline) : outline
    outlines.set(stroke, cached)
  }
  return cached
}

function fillOutline(ctx: Ctx, outline: Path2D | number[][]): void {
  if (Array.isArray(outline)) {
    ctx.beginPath()
    traceOutline(ctx, outline)
    ctx.fill()
  } else {
    ctx.fill(outline)
  }
}

/** Highlighter ink is see-through and sits under the pen: multiplied on a light sheet. */
function withHighlighter(ctx: Ctx, theme: SketchTheme, draw: () => void): void {
  ctx.save()
  ctx.globalAlpha = theme.dark ? 0.55 : 0.45
  if (!theme.dark) ctx.globalCompositeOperation = 'multiply'
  draw()
  ctx.restore()
}

export function drawStroke(ctx: Ctx, stroke: Stroke, theme: SketchTheme): void {
  ctx.fillStyle = resolveColor(stroke.color, theme)
  const outline = cachedOutline(stroke)
  if (stroke.tool === 'highlighter') withHighlighter(ctx, theme, () => fillOutline(ctx, outline))
  else fillOutline(ctx, outline)
}

/** A stroke still being drawn: not cached, its end not yet final. */
export function drawLiveStroke(ctx: Ctx, tool: Tool, width: number, color: string, points: readonly number[], theme: SketchTheme): void {
  if (points.length < 3) return
  ctx.fillStyle = resolveColor(color, theme)
  const outline = strokeOutline(tool, width, points, false)
  if (tool === 'highlighter') withHighlighter(ctx, theme, () => fillOutline(ctx, outline))
  else fillOutline(ctx, outline)
}

export function drawShape(ctx: Ctx, shape: Shape, theme: SketchTheme): void {
  ctx.strokeStyle = resolveColor(shape.color, theme)
  ctx.lineWidth = shape.width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  const { x1, y1, x2, y2 } = shape
  if (shape.type === 'rect') {
    ctx.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1))
  } else if (shape.type === 'ellipse') {
    ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2)
  } else {
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    if (shape.type === 'arrow' && (x1 !== x2 || y1 !== y2)) {
      const angle = Math.atan2(y2 - y1, x2 - x1)
      const head = Math.min(arrowHeadLength(shape.width), Math.hypot(x2 - x1, y2 - y1) * 0.6 + shape.width)
      for (const side of [-1, 1]) {
        ctx.moveTo(x2, y2)
        ctx.lineTo(x2 - head * Math.cos(angle + side * 0.45), y2 - head * Math.sin(angle + side * 0.45))
      }
    }
  }
  ctx.stroke()
}

export function drawText(ctx: Ctx, box: TextBox, theme: SketchTheme): void {
  const layout = layoutText(box)
  ctx.fillStyle = resolveColor(box.color, theme)
  ctx.font = fontFor(box.size)
  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'
  // Half the extra line height above the letters, as CSS puts it (so the textarea matches).
  const lead = (layout.lineHeight - box.size) / 2
  layout.lines.forEach((line, i) => {
    if (line) ctx.fillText(line, box.x, box.y + lead + i * layout.lineHeight)
  })
}

export function drawItem(ctx: Ctx, item: SketchItem, theme: SketchTheme): void {
  if (isStroke(item)) drawStroke(ctx, item, theme)
  else if (isText(item)) drawText(ctx, item, theme)
  else drawShape(ctx, item, theme)
}

export interface DrawItemsOptions {
  /** Only items whose bounds touch this box are drawn. */
  visible?: Rect
  /** Items not drawn here (being moved, or edited in the textarea). */
  hidden?: ReadonlySet<string>
}

/** Draws items in order, highlighter strokes first (under everything else). Returns how many were drawn. */
export function drawItems(ctx: Ctx, items: readonly SketchItem[], theme: SketchTheme, options: DrawItemsOptions = {}): number {
  const { visible, hidden } = options
  const shown = items.filter((item) => !hidden?.has(item.id) && (!visible || rectsIntersect(itemBounds(item), visible)))
  const isHighlight = (item: SketchItem) => isStroke(item) && item.tool === 'highlighter'
  for (const item of shown) if (isHighlight(item)) drawItem(ctx, item, theme)
  for (const item of shown) if (!isHighlight(item)) drawItem(ctx, item, theme)
  return shown.length
}

/** The spacing of the background pattern (sheet units), doubled while it would be too dense to see. */
export function patternStep(background: SketchData['background'], zoom: number): number {
  let step = background === 'lines' ? 32 : 24
  const minScreen = background === 'dots' ? 12 : 8
  while (step * zoom < minScreen) step *= 2
  return step
}

function drawPattern(ctx: Ctx, background: SketchData['background'], area: Rect, zoom: number, theme: SketchTheme): void {
  if (background === 'plain') return
  const step = patternStep(background, zoom)
  const px = 1 / zoom
  const startX = Math.floor(area.minX / step) * step
  const startY = Math.floor(area.minY / step) * step
  if (background === 'dots') {
    ctx.fillStyle = theme.pageBorder
    const size = Math.max(1.6 * px, 0.8)
    for (let x = startX; x <= area.maxX; x += step) {
      for (let y = startY; y <= area.maxY; y += step) ctx.fillRect(x - size / 2, y - size / 2, size, size)
    }
    return
  }
  ctx.strokeStyle = theme.pattern
  ctx.lineWidth = px
  ctx.beginPath()
  if (background === 'grid') {
    for (let x = startX; x <= area.maxX; x += step) {
      ctx.moveTo(x, area.minY)
      ctx.lineTo(x, area.maxY)
    }
  }
  for (let y = startY; y <= area.maxY; y += step) {
    ctx.moveTo(area.minX, y)
    ctx.lineTo(area.maxX, y)
  }
  ctx.stroke()
}

/** The paper: one endless sheet, or the pages on the desk. `visible` is the part of the sheet shown. */
export function drawBackground(ctx: Ctx, data: Pick<SketchData, 'layout' | 'background' | 'pages'>, theme: SketchTheme, visible: Rect, zoom: number): void {
  if (data.layout !== 'pages') {
    ctx.fillStyle = theme.paper
    ctx.fillRect(visible.minX, visible.minY, visible.maxX - visible.minX, visible.maxY - visible.minY)
    drawPattern(ctx, data.background, visible, zoom, theme)
    return
  }
  ctx.fillStyle = theme.desk
  ctx.fillRect(visible.minX, visible.minY, visible.maxX - visible.minX, visible.maxY - visible.minY)
  for (let i = 0; i < data.pages; i++) {
    const page: Rect = { minX: 0, minY: pageTop(i), maxX: PAGE.width, maxY: pageTop(i) + PAGE.height }
    if (!rectsIntersect(page, visible)) continue
    ctx.fillStyle = theme.paper
    ctx.fillRect(page.minX, page.minY, PAGE.width, PAGE.height)
    ctx.save()
    ctx.beginPath()
    ctx.rect(page.minX, page.minY, PAGE.width, PAGE.height)
    ctx.clip()
    drawPattern(ctx, data.background, {
      minX: Math.max(page.minX, visible.minX), minY: Math.max(page.minY, visible.minY),
      maxX: Math.min(page.maxX, visible.maxX), maxY: Math.min(page.maxY, visible.maxY),
    }, zoom, theme)
    ctx.restore()
    ctx.strokeStyle = theme.pageBorder
    ctx.lineWidth = 1 / zoom
    ctx.strokeRect(page.minX, page.minY, PAGE.width, PAGE.height)
  }
}

export interface Scene {
  data: Pick<SketchData, 'layout' | 'background' | 'pages'>
  items: readonly SketchItem[]
  view: Viewport
  /** The canvas in CSS pixels, and its device pixel ratio. */
  width: number
  height: number
  dpr: number
  theme: SketchTheme
  hidden?: ReadonlySet<string>
}

/** Sets the context to draw in sheet units for this view. */
export function applyView(ctx: Ctx, view: Viewport, dpr: number): void {
  ctx.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, dpr * view.x, dpr * view.y)
}

/** The part of the sheet the scene shows. */
export function sceneRect(scene: Pick<Scene, 'view' | 'width' | 'height'>): Rect {
  const { view, width, height } = scene
  return { minX: -view.x / view.zoom, minY: -view.y / view.zoom, maxX: (width - view.x) / view.zoom, maxY: (height - view.y) / view.zoom }
}

/** Draws the whole scene: the paper, then the items that can be seen. Returns how many items were drawn. */
export function drawScene(ctx: Ctx, scene: Scene): number {
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, scene.width * scene.dpr, scene.height * scene.dpr)
  applyView(ctx, scene.view, scene.dpr)
  const visible = sceneRect(scene)
  drawBackground(ctx, scene.data, scene.theme, visible, scene.view.zoom)
  return drawItems(ctx, scene.items, scene.theme, { visible, hidden: scene.hidden })
}
