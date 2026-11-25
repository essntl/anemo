/**
 * The sketch model: what a drawing sheet is made of, as the server stores it (the JSON
 * block of a `.sketch.md` document, checked by backend/app/features/documents/sketch.py).
 *
 * Coordinates are sheet units (CSS pixels at 100 % zoom). A stroke's `points` is flat:
 * x, y, pressure (0–1), x, y, pressure, … A colour is "#rrggbb" or "ink" (the theme's text
 * colour, so black ink stays readable on a dark sheet).
 */
import type { Schemas } from '@/api/client'

export type Stroke = Schemas['Stroke']
export type Shape = Schemas['Shape']
export type TextBox = Schemas['TextBox']
export type SketchItem = Stroke | Shape | TextBox
/** As the server sends it, with `items` always there. */
export type SketchData = Omit<Schemas['SketchData'], 'items'> & { items: SketchItem[] }
export type ShapeKind = Shape['type']
export type SketchLayout = SketchData['layout']
export type SketchBackground = SketchData['background']

/** The limits the server enforces (sketch.py); the editor stays inside them. */
export const LIMITS = {
  items: 20_000,
  pointsPerStroke: 5_000,
  points: 400_000,
  textChars: 2_000,
  totalTextChars: 100_000,
  pages: 100,
  coord: 1_000_000,
  minWidth: 0.1,
  maxWidth: 200,
  minFontSize: 4,
  maxFontSize: 400,
  /** The whole document file (bytes), as for any document. */
  fileBytes: 2 * 1024 * 1024,
} as const

/** An A4-like page in sheet units (A4 at 96 dpi), and the gap between pages. */
export const PAGE = { width: 794, height: 1123, gap: 32 } as const

export const INK = 'ink'

export function emptySketch(layout: SketchLayout = 'infinite'): SketchData {
  return { v: 1, layout, background: 'plain', pages: 1, items: [] }
}

/** A short id for a new item, unique enough within one sheet. */
export function newItemId(): string {
  const random = Math.random().toString(36).slice(2, 8)
  return `${Date.now().toString(36)}${random}`
}
