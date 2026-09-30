/**
 * Attachments picked in the composer. Files upload as soon as they are added,
 * so sending only has to pass the finished attachment ids.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, type Schemas } from '@/api/client'

export type UploadedAttachment = Schemas['AttachmentOut']

export interface PendingAttachment {
  key: string
  file: File
  status: 'uploading' | 'ready' | 'error'
  previewUrl: string | null
  uploaded?: UploadedAttachment
  error?: string
}

async function upload(file: File): Promise<UploadedAttachment> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch('/api/attachments', { method: 'POST', body: form, credentials: 'same-origin' })
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } }
  if (!res.ok) {
    throw new ApiError(res.status, body.error?.code ?? `http_${res.status}`, body.error?.message ?? 'Upload failed')
  }
  return body as UploadedAttachment
}

export const MAX_ATTACHMENTS = 10

export function useAttachments() {
  const [items, setItems] = useState<PendingAttachment[]>([])
  const itemsRef = useRef(items)
  useEffect(() => {
    itemsRef.current = items
  })

  // Free image preview URLs when the composer goes away.
  useEffect(() => () => itemsRef.current.forEach((i) => i.previewUrl && URL.revokeObjectURL(i.previewUrl)), [])

  const add = useCallback((files: FileList | File[]) => {
    const room = MAX_ATTACHMENTS - itemsRef.current.length
    const added = Array.from(files).slice(0, Math.max(0, room)).map<PendingAttachment>((file) => ({
      key: crypto.randomUUID(),
      file,
      status: 'uploading',
      previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
    }))
    setItems((prev) => [...prev, ...added])
    for (const item of added) {
      upload(item.file).then(
        (uploaded) =>
          setItems((prev) => prev.map((i) => (i.key === item.key ? { ...i, status: 'ready', uploaded } : i))),
        (err: unknown) =>
          setItems((prev) =>
            prev.map((i) =>
              i.key === item.key
                ? { ...i, status: 'error', error: err instanceof Error ? err.message : 'Upload failed' }
                : i,
            ),
          ),
      )
    }
  }, [])

  const remove = useCallback((key: string) => {
    setItems((prev) => {
      const gone = prev.find((i) => i.key === key)
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl)
      return prev.filter((i) => i.key !== key)
    })
  }, [])

  const clear = useCallback(() => setItems([]), [])

  return {
    items,
    add,
    remove,
    clear,
    uploading: items.some((i) => i.status === 'uploading'),
    readyIds: items.filter((i) => i.status === 'ready').map((i) => i.uploaded!.id),
  }
}
