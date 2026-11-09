/** Files attached to a message: uploaded to Anemo as in its own chat (25 MB each, 10 a message). */
import { unwrap, type Api, type Schemas } from '@/shared/api'

export type Uploaded = Schemas['AttachmentOut']
export const MAX_FILES = 10
export const MAX_BYTES = 25 * 1024 * 1024

export interface Pending {
  key: string
  name: string
  size: number
  /** A local preview for images (a blob: address of this panel). */
  preview: string | null
  status: 'uploading' | 'ready' | 'error'
  id?: string
  error?: string
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Why a file can't be attached, or null. */
export function refusal(file: { size: number }, already: number): string | null {
  if (already >= MAX_FILES) return `A message takes at most ${MAX_FILES} files.`
  if (file.size > MAX_BYTES) return 'Larger than 25 MB.'
  if (file.size === 0) return 'The file is empty.'
  return null
}

export async function upload(api: Api, file: File): Promise<Uploaded> {
  const form = new FormData()
  form.append('file', file, file.name || 'pasted-image.png')
  return unwrap(await api.POST('/api/attachments', { body: form as never, bodySerializer: (b) => b as unknown as FormData }))
}

/** An attachment's content as a blob: address (it needs the token, so no plain link). */
export async function contentUrl(api: Api, id: string): Promise<string> {
  const blob = unwrap(await api.GET('/api/attachments/{attachment_id}/content', { params: { path: { attachment_id: id } }, parseAs: 'blob' })) as unknown as Blob
  return URL.createObjectURL(blob)
}

/** The files in a paste or a drop. */
export function filesFrom(data: DataTransfer | null): File[] {
  return data ? [...data.files] : []
}
