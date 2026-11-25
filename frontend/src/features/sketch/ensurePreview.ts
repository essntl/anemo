/**
 * The sketch's image on the server: drawn here (canvas/preview.ts) and uploaded for the
 * drawing version it shows. Embeds, chat attachments and transcription all use it.
 */
import type { QueryClient } from '@tanstack/react-query'
import { ApiError } from '@/api/client'
import { t } from '@/lib/i18n'
import { type DocumentContent, documentKey } from '@/features/documents/api'
import { renderPreview } from './canvas/preview'
import type { SketchData } from './model'
import { toSketchData } from './file'
import { fetchDocument, type PreviewInfo, sketchAttachment, type SketchAttachment, uploadPreview } from './api'

export const isOutdated = (err: unknown) => err instanceof ApiError && err.code === 'preview_outdated'

/**
 * Draws `data` and uploads it as the image of `drawingHash`. Returns null when the
 * drawing has changed on the server since (a newer save uploads its own image).
 */
export async function uploadDrawing(id: string, data: SketchData, drawingHash: string, qc?: QueryClient): Promise<PreviewInfo | null> {
  const image = await renderPreview(data)
  try {
    const preview = await uploadPreview(id, image, drawingHash)
    // The open document now has a current image (unless it moved on meanwhile).
    qc?.setQueryData<DocumentContent>(documentKey(id), (old) =>
      old?.sketch && old.sketch.drawing_hash === preview.drawing_hash ? { ...old, sketch: { ...old.sketch, preview, preview_current: true } } : old)
    return preview
  } catch (err) {
    if (isOutdated(err)) return null
    throw err
  }
}

/** Makes sure the server has an image of the sketch as it is now. */
export async function ensurePreview(id: string, qc?: QueryClient): Promise<void> {
  // Twice at most: a save from elsewhere can come between reading and uploading.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const doc = await fetchDocument(id)
    const sketch = doc.sketch
    if (!sketch?.data || !sketch.drawing_hash) {
      throw new Error(sketch?.error ?? t('This sketch’s drawing can’t be read.'))
    }
    if (sketch.preview_current) return
    if (await uploadDrawing(id, toSketchData(sketch.data), sketch.drawing_hash, qc)) return
  }
  throw new Error(t('The sketch keeps changing. Try again in a moment.'))
}

/** The sketch's image as a chat attachment, made current first. */
export async function sketchForChat(id: string, qc?: QueryClient): Promise<SketchAttachment> {
  await ensurePreview(id, qc)
  return sketchAttachment(id)
}
