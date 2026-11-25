/**
 * The view onto the sheet: screen = sheet · zoom + (x, y), in CSS pixels of the canvas.
 * Pure maths: converting points, zooming around a point, fitting a box, the visible area.
 */
import { LIMITS, PAGE, pagesHeight, type SketchData } from '../model'
import { itemsBounds, rectHeight, rectWidth, type Point, type Rect } from './geometry'

export interface Viewport {
  x: number
  y: number
  zoom: number
}

export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 8
/** The steps of the zoom buttons. */
export const ZOOM_STEP = 1.25

export const clampZoom = (z: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

export const toSheet = (v: Viewport, sx: number, sy: number): Point => ({ x: (sx - v.x) / v.zoom, y: (sy - v.y) / v.zoom })
export const toScreen = (v: Viewport, x: number, y: number): Point => ({ x: x * v.zoom + v.x, y: y * v.zoom + v.y })

/** Keeps the sheet point at the middle of the view within the sheet's coordinate limits. */
export function clampViewport(v: Viewport, width = 0, height = 0): Viewport {
  const zoom = clampZoom(v.zoom)
  const centre = toSheet({ ...v, zoom }, width / 2, height / 2)
  const cx = Math.min(LIMITS.coord, Math.max(-LIMITS.coord, centre.x))
  const cy = Math.min(LIMITS.coord, Math.max(-LIMITS.coord, centre.y))
  return { zoom, x: width / 2 - cx * zoom, y: height / 2 - cy * zoom }
}

/** Zooms by `factor`, keeping the sheet point under (sx, sy) where it is on screen. */
export function zoomAt(v: Viewport, factor: number, sx: number, sy: number): Viewport {
  const zoom = clampZoom(v.zoom * factor)
  const k = zoom / v.zoom
  return { zoom, x: sx - (sx - v.x) * k, y: sy - (sy - v.y) * k }
}

export const panBy = (v: Viewport, dx: number, dy: number): Viewport => ({ ...v, x: v.x + dx, y: v.y + dy })

/** The part of the sheet a view of `width` × `height` shows. */
export function visibleRect(v: Viewport, width: number, height: number): Rect {
  const a = toSheet(v, 0, 0), b = toSheet(v, width, height)
  return { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y }
}

/**
 * The view that shows `rect` whole and centred, with `padding` screen pixels around it,
 * zoomed in no further than `maxZoom`. `top` pixels at the top are covered (the toolbar).
 */
export function fitRect(rect: Rect, width: number, height: number, padding = 32, maxZoom = 1, top = 0): Viewport {
  const w = Math.max(rectWidth(rect), 1), h = Math.max(rectHeight(rect), 1)
  const room = Math.max(1, height - top)
  const zoom = clampZoom(Math.min(maxZoom, (width - padding * 2) / w, (room - padding * 2) / h))
  return {
    zoom,
    x: width / 2 - ((rect.minX + rect.maxX) / 2) * zoom,
    y: top + room / 2 - ((rect.minY + rect.maxY) / 2) * zoom,
  }
}

/** The box of all pages in the pages layout. */
export const pagesRect = (pages: number): Rect => ({ minX: 0, minY: 0, maxX: PAGE.width, maxY: pagesHeight(pages) })

/** What "fit" shows: all pages, or everything drawn (null for an empty infinite sheet). */
export function contentRect(data: SketchData): Rect | null {
  return data.layout === 'pages' ? pagesRect(data.pages) : itemsBounds(data.items)
}

/**
 * The view a sheet opens with: the first page across the width, everything drawn, or the
 * origin at 100 %. `top`: screen pixels covered at the top (the toolbar).
 */
export function initialViewport(data: SketchData, width: number, height: number, top = 0): Viewport {
  if (data.layout === 'pages') {
    const zoom = clampZoom(Math.min(1, (width - 32) / PAGE.width))
    return { zoom, x: (width - PAGE.width * zoom) / 2, y: top + 16 }
  }
  const content = itemsBounds(data.items)
  return content ? fitRect(content, width, height, 48, 1, top) : { x: 0, y: top, zoom: 1 }
}

/** The view that fits the content (or, for an empty sheet, the origin at 100 %). */
export function fitViewport(data: SketchData, width: number, height: number, top = 0): Viewport {
  const rect = contentRect(data)
  return rect ? fitRect(rect, width, height, 32, data.layout === 'pages' ? 2 : 1, top) : { x: 0, y: top, zoom: 1 }
}
