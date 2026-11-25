/**
 * Attachments picked in the composer. Files upload as soon as they are added,
 * so sending only has to pass the finished attachment ids.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, type Schemas } from '@/api/client'
import { t } from '@/lib/i18n'

export type UploadedAttachment = Schemas['AttachmentOut']

export interface PendingAttachment {
  key: string
  /** What the chip shows. */
  name: string
  size: number
  status: 'uploading' | 'ready' | 'error'
  previewUrl: string | null
  uploaded?: UploadedAttachment
  error?: string
}

/** A new chat started from elsewhere with attachments already made (e.g. a sketch's image); see NewChatPage. */
export interface NewChatState {
  attachments?: UploadedAttachment[]
}

/** The address of an attachment's file, as the app serves it. */
export const attachmentUrl = (id: string) => `/api/attachments/${id}/content`

const previewOf = (uploaded: UploadedAttachment) => (uploaded.kind === 'image' ? attachmentUrl(uploaded.id) : null)

const readyItem = (uploaded: UploadedAttachment): PendingAttachment => ({
  key: uploaded.id,
  name: uploaded.filename,
  size: uploaded.size,
  status: 'ready',
  previewUrl: previewOf(uploaded),
  uploaded,
})

/** Only image previews made here (blob: addresses) need freeing. */
function free(url: string | null) {
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url)
}

/** Uploads one file as an attachment (also used by the Code page for its images). */
export async function uploadAttachment(file: File): Promise<UploadedAttachment> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch('/api/attachments', { method: 'POST', body: form, credentials: 'same-origin' })
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } }
  if (!res.ok) {
    throw new ApiError(res.status, body.error?.code ?? `http_${res.status}`, body.error?.message ?? t('Upload failed'))
  }
  return body as UploadedAttachment
}

export const MAX_ATTACHMENTS = 10

/** `initial`: attachments already made, to start with (a chat started from a sketch). */
export function useAttachments(initial?: UploadedAttachment[]) {
  const [items, setItems] = useState<PendingAttachment[]>(() => (initial ?? []).slice(0, MAX_ATTACHMENTS).map(readyItem))
  const itemsRef = useRef(items)
  useEffect(() => {
    itemsRef.current = items
  })

  // Free image preview URLs when the composer goes away.
  useEffect(() => () => itemsRef.current.forEach((i) => free(i.previewUrl)), [])

  /** Shows the item at once (uploading) and fills it in when `upload` is done. */
  const track = useCallback((item: PendingAttachment, upload: Promise<UploadedAttachment>) => {
    upload.then(
      (uploaded) =>
        setItems((prev) => prev.map((i) => (i.key === item.key ? { ...i, status: 'ready', size: uploaded.size, previewUrl: i.previewUrl ?? previewOf(uploaded), uploaded } : i))),
      (err: unknown) =>
        setItems((prev) =>
          prev.map((i) =>
            i.key === item.key
              ? { ...i, status: 'error', error: err instanceof Error ? err.message : t('Upload failed') }
              : i,
          ),
        ),
    )
  }, [])

  const add = useCallback((files: FileList | File[]) => {
    const room = MAX_ATTACHMENTS - itemsRef.current.length
    const added = Array.from(files).slice(0, Math.max(0, room)).map((file) => ({
      item: {
        key: crypto.randomUUID(),
        name: file.name,
        size: file.size,
        status: 'uploading',
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
      } satisfies PendingAttachment,
      file,
    }))
    setItems((prev) => [...prev, ...added.map((a) => a.item)])
    for (const { item, file } of added) track(item, uploadAttachment(file))
  }, [track])

  /**
   * An attachment made some other way than uploading a file (a sketch's image): shown as
   * `name` while `make` runs.
   */
  const addMade = useCallback((name: string, make: () => Promise<UploadedAttachment>) => {
    if (itemsRef.current.length >= MAX_ATTACHMENTS) return
    const item: PendingAttachment = { key: crypto.randomUUID(), name, size: 0, status: 'uploading', previewUrl: null }
    setItems((prev) => [...prev, item])
    track(item, make())
  }, [track])

  const remove = useCallback((key: string) => {
    setItems((prev) => {
      const gone = prev.find((i) => i.key === key)
      if (gone) free(gone.previewUrl)
      return prev.filter((i) => i.key !== key)
    })
  }, [])

  const clear = useCallback(() => setItems([]), [])
  /** Put back attachments taken away by `clear` (a send that failed). */
  const restore = useCallback((back: PendingAttachment[]) => setItems((prev) => [...back, ...prev]), [])

  return {
    items,
    add,
    addMade,
    remove,
    clear,
    restore,
    uploading: items.some((i) => i.status === 'uploading'),
    readyIds: items.filter((i) => i.status === 'ready').map((i) => i.uploaded!.id),
  }
}
