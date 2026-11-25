/**
 * The sketch rendered as an image, for the preview the server keeps (embeds, chat
 * attachments, models, transcription).
 *
 * Contract: always the light theme ("ink" is dark) on a white background; the drawn area
 * with some margin (all pages for the pages layout); the longest side at most `maxEdge`
 * (default 1600) and never more than 4096 px; an empty sheet gives a small blank image.
 * Resolves to a PNG Blob. It draws through render.ts, as the canvas does.
 */
import type { SketchData } from '../model'
import { inflate, itemsBounds, rectHeight, rectWidth, type Rect } from './geometry'
import { LIGHT_THEME } from './palette'
import { drawScene, type Ctx } from './render'
import { pagesRect } from './viewport'

export interface PreviewOptions {
  maxEdge?: number
}

export const PREVIEW_MAX_EDGE = 1600
export const PREVIEW_HARD_LIMIT = 4096
export const BLANK_SIZE = { width: 400, height: 300 } as const
/** Room around the drawing, in sheet units. */
const MARGIN = 24
/** A small drawing is enlarged at most this much (so a doodle doesn't become a blur). */
const MAX_SCALE = 2

export interface PreviewLayout {
  /** The part of the sheet shown (null: empty sheet). */
  area: Rect | null
  width: number
  height: number
  scale: number
}

/** What the preview shows and how big it is (pure: the sizes, without drawing). */
export function previewLayout(data: SketchData, maxEdge = PREVIEW_MAX_EDGE): PreviewLayout {
  const edge = Math.max(16, Math.min(PREVIEW_HARD_LIMIT, Math.floor(maxEdge)))
  const content = itemsBounds(data.items)
  const area = data.layout === 'pages' ? pagesRect(data.pages) : content && inflate(content, MARGIN)
  if (!area) return { area: null, ...BLANK_SIZE, scale: 1 }
  const w = Math.max(rectWidth(area), 1), h = Math.max(rectHeight(area), 1)
  const scale = Math.min(MAX_SCALE, edge / Math.max(w, h))
  return {
    area,
    width: Math.min(edge, Math.max(1, Math.round(w * scale))),
    height: Math.min(edge, Math.max(1, Math.round(h * scale))),
    scale,
  }
}

interface Surface {
  ctx: Ctx
  toBlob: () => Promise<Blob>
}

/** A canvas to draw on: an HTML canvas (toBlob), or an OffscreenCanvas (convertToBlob) where there is none. */
function createSurface(width: number, height: number): Surface {
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = typeof canvas.toBlob === 'function' ? canvas.getContext('2d') : null
    if (ctx) {
      return {
        ctx,
        toBlob: () => new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The preview could not be made.'))), 'image/png')),
      }
    }
  }
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')
    if (ctx) return { ctx, toBlob: () => canvas.convertToBlob({ type: 'image/png' }) }
  }
  throw new Error('This browser cannot draw the preview.')
}

export async function renderPreview(data: SketchData, options: PreviewOptions = {}): Promise<Blob> {
  const layout = previewLayout(data, options.maxEdge)
  const surface = createSurface(layout.width, layout.height)
  const { ctx } = surface
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, layout.width, layout.height)
  if (layout.area) {
    drawScene(ctx, {
      data, items: data.items, theme: LIGHT_THEME, width: layout.width, height: layout.height, dpr: 1,
      view: { zoom: layout.scale, x: -layout.area.minX * layout.scale, y: -layout.area.minY * layout.scale },
    })
  }
  return surface.toBlob()
}
