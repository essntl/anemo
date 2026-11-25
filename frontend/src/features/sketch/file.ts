/**
 * Reading a drawing as the server sends it, and out of a `.sketch.md` file's text (an
 * earlier version in the history). The file format is backend/app/features/documents/sketch.py:
 * the drawing is the JSON in the ````anemo-sketch block at the end.
 */
import type { Schemas } from '@/api/client'
import type { SketchData } from './model'

/** The server's drawing, with `items` always there. */
export function toSketchData(data: Schemas['SketchData']): SketchData {
  return { ...data, items: data.items ?? [] } as SketchData
}

const FENCE = /^````anemo-sketch[ \t]*\r?\n([\s\S]*?)\r?\n````[ \t]*\r?$/m

/**
 * The drawing in a sketch file's text, or null when there is none or it can't be read.
 * Only the shape is checked here: the canvas draws text as text, never as markup.
 */
export function sketchFromFile(content: string): SketchData | null {
  const block = FENCE.exec(content)?.[1]
  if (!block) return null
  try {
    const value = JSON.parse(block) as Partial<SketchData> | null
    if (!value || typeof value !== 'object' || !Array.isArray(value.items)) return null
    return {
      v: 1,
      layout: value.layout === 'pages' ? 'pages' : 'infinite',
      background: value.background ?? 'plain',
      pages: typeof value.pages === 'number' ? value.pages : 1,
      items: value.items,
    }
  } catch {
    return null
  }
}
