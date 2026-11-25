/**
 * The sketch endpoints (backend/app/features/documents/sketch_router.py). A sketch is a
 * document: it is read with GET /documents/{id} (its `sketch` field) and created, moved,
 * restored and deleted with the documents' own calls (features/documents/api.ts).
 */
import { useQuery } from '@tanstack/react-query'
import { api, ApiError, type Schemas, unwrap } from '@/api/client'
import { t } from '@/lib/i18n'
import { type DocumentContent, documentKey } from '@/features/documents/api'
import type { SketchData } from './model'

export type SketchState = Schemas['SketchOut']
export type PreviewInfo = Schemas['PreviewOut']
export type SketchAttachment = Schemas['AttachmentOut']

export async function fetchDocument(id: string): Promise<DocumentContent> {
  return unwrap(await api.GET('/api/documents/{document_id}', { params: { path: { document_id: id } } }))
}

/**
 * Saves the drawing (and the title, when given). `baseHash` is the file version the
 * drawing was made on; null writes over whatever is there (after a conflict).
 */
export async function saveSketch(id: string, data: SketchData, baseHash: string | null, title?: string): Promise<DocumentContent> {
  return unwrap(
    await api.PUT('/api/documents/{document_id}/sketch', {
      params: { path: { document_id: id } },
      body: { data, base_hash: baseHash, ...(title?.trim() ? { title: title.trim() } : {}) },
    }),
  )
}

/** Uploads the image of the drawing version `drawingHash` (409 preview_outdated when it changed since). */
export async function uploadPreview(id: string, image: Blob, drawingHash: string): Promise<PreviewInfo> {
  const form = new FormData()
  form.append('file', image, 'preview.png')
  form.append('drawing_hash', drawingHash)
  const res = await fetch(`/api/documents/${id}/sketch/preview`, { method: 'PUT', body: form, credentials: 'same-origin' })
  const body = (await res.json().catch(() => ({}))) as Partial<PreviewInfo> & { error?: { code?: string; message?: string } }
  if (!res.ok) {
    throw new ApiError(res.status, body.error?.code ?? `http_${res.status}`, body.error?.message ?? t('Upload failed'))
  }
  return body as PreviewInfo
}

/** The sketch's current image as a chat attachment (409 preview_outdated when it isn't current). */
export async function sketchAttachment(id: string): Promise<SketchAttachment> {
  return unwrap(await api.POST('/api/documents/{document_id}/sketch/attachment', { params: { path: { document_id: id } } }))
}

/** Asks a model to read the drawing (in the background). */
export async function requestTranscription(id: string): Promise<void> {
  unwrap(await api.POST('/api/documents/{document_id}/sketch/transcribe', { params: { path: { document_id: id } } }))
}

const POLL_MS = 4000

/**
 * While a transcription is queued: look at the document every few seconds. (The server
 * also announces the saved file with a document.changed event, which refreshes it.)
 */
export function useTranscriptionPoll(id: string, queued: boolean) {
  useQuery({
    queryKey: documentKey(id),
    queryFn: () => fetchDocument(id),
    enabled: queued,
    refetchInterval: queued ? POLL_MS : false,
  })
}

/** A failure that is worth trying again later: no connection, or the server is away. */
export function isTransient(err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 0 || err.status >= 500
  return err instanceof TypeError // fetch: the network
}
