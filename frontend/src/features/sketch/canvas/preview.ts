/**
 * STUB (replaced by the canvas implementation): the sketch rendered as an image, for the
 * preview the server keeps (embeds, chat attachments, models, transcription).
 *
 * Contract: always the light theme ("ink" is dark) on a white background; the drawn area
 * with some margin (all used pages for the pages layout); the longest side at most
 * `maxEdge` (default 1600) and never more than 4096 px; an empty sheet gives a small blank
 * image. Resolves to a PNG Blob.
 */
import type { SketchData } from '../model'

export interface PreviewOptions {
  maxEdge?: number
}

export async function renderPreview(_data: SketchData, _options: PreviewOptions = {}): Promise<Blob> {
  return new Blob([], { type: 'image/png' })
}
