/** The maths of the avatar cropper (AvatarCropper.tsx): a square inside a picture. */
import type { CropBox } from '@/features/appearance/api'

export const MAX_ZOOM = 4

export interface CropState {
  /** Top-left corner of the square, in pixels of the picture. */
  x: number
  y: number
  zoom: number
}

/** The side of the square in picture pixels at a zoom (1: the whole shorter side). */
export function cropSide(width: number, height: number, zoom: number): number {
  return Math.min(width, height) / zoom
}

/** Keep the square inside the picture. */
export function clampCrop(width: number, height: number, c: CropState): CropState {
  const zoom = Math.min(MAX_ZOOM, Math.max(1, c.zoom))
  const side = cropSide(width, height, zoom)
  return {
    zoom,
    x: Math.min(Math.max(0, c.x), width - side),
    y: Math.min(Math.max(0, c.y), height - side),
  }
}

/** What the server's PUT /appearance/avatar takes. */
export function toCropBox(width: number, height: number, c: CropState): CropBox {
  return { x: c.x / width, y: c.y / height, size: 1 / c.zoom }
}

/** Zoom around the middle of the square, so zooming doesn't make the picture jump. */
export function zoomTo(width: number, height: number, c: CropState, zoom: number): CropState {
  const before = cropSide(width, height, c.zoom)
  const after = cropSide(width, height, zoom)
  return clampCrop(width, height, { zoom, x: c.x + (before - after) / 2, y: c.y + (before - after) / 2 })
}
