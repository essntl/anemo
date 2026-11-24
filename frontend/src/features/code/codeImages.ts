/**
 * Images for a Claude Code prompt (docs/specs/code-sessions.md §13): in the New job dialog,
 * the follow-up box and a queued message.
 *
 * Each image is uploaded as an attachment as soon as it is added (POST /api/attachments,
 * the chat's upload), so sending, and a message queued for later, only carry the ids.
 * The server checks them again, scales them down and sends them to the computer, which
 * puts them in the job's folder and lists their paths in the prompt for Claude Code.
 */
import { type ClipboardEvent, type DragEvent, useCallback, useEffect, useRef, useState } from 'react'
import { pastedFiles } from '@/features/chat/pastedFiles'
import { uploadAttachment } from '@/features/chat/useAttachments'
import { formatSize } from '@/lib/format'
import { t } from '@/lib/i18n'

/** An uploaded image, as a draft, a queued message and a request keep it. */
export interface CodeImage {
  /** The attachment's id. */
  id: string
  /** The name it was uploaded with (for the chip; the computer gets a name the server makes). */
  name: string
  size: number
}

/** The same numbers as the server (backend/app/features/code_sessions/images.py). */
export const MAX_IMAGES = 8
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
/** For the file picker. */
export const IMAGE_ACCEPT = IMAGE_TYPES.join(',')

/** Where the page shows an uploaded image (same origin: the user's own upload). */
export const imageUrl = (id: string) => `/api/attachments/${encodeURIComponent(id)}/content`

/** The ids to send: none is no field at all (a request without images looks as before). */
export const imageIds = (images: readonly CodeImage[]): { image_ids?: string[] } =>
  images.length ? { image_ids: images.map((i) => i.id) } : {}

/**
 * Which of `files` can be added to `have` images: PNG, JPEG, WebP or GIF, at most
 * MAX_IMAGE_BYTES each and MAX_IMAGES in all. `refused` says why the others weren't, one
 * sentence each.
 */
export function checkImages(files: readonly File[], have: number): { accepted: File[]; refused: string[] } {
  const accepted: File[] = []
  const refused: string[] = []
  for (const file of files) {
    if (!IMAGE_TYPES.includes(file.type)) {
      refused.push(t('“{name}” isn’t a PNG, JPEG, WebP or GIF image.', { name: file.name || t('The file') }))
    } else if (file.size > MAX_IMAGE_BYTES) {
      refused.push(t('“{name}” is larger than {size}.', { name: file.name, size: formatSize(MAX_IMAGE_BYTES) }))
    } else if (have + accepted.length >= MAX_IMAGES) {
      refused.push(t('At most {n} images can go with one message.', { n: MAX_IMAGES }))
      break
    } else {
      accepted.push(file)
    }
  }
  return { accepted, refused }
}

/** An image still uploading, or one whose upload failed (shown until removed). */
export interface PendingImage {
  key: string
  name: string
  size: number
  previewUrl: string
  status: 'uploading' | 'error'
  error?: string
}

/**
 * The images of one box. `images` (the uploaded ones) is kept by the caller, so it can
 * last as long as the box's text does (a thread's draft survives leaving the thread);
 * what is still uploading is kept here. `onRefused`: the sentences for files that weren't
 * taken.
 */
export function useCodeImages({ images, setImages, onRefused }: {
  images: readonly CodeImage[]
  setImages: (update: (images: CodeImage[]) => CodeImage[]) => void
  onRefused: (message: string) => void
}) {
  const [pending, setPending] = useState<PendingImage[]>([])
  // Uploads removed before they finished: their image isn't added when they do.
  const removed = useRef(new Set<string>())
  const live = useRef({ images, pending })
  useEffect(() => {
    live.current = { images, pending }
  })
  // Free the previews of uploads when the box goes away.
  useEffect(() => () => live.current.pending.forEach((p) => URL.revokeObjectURL(p.previewUrl)), [])

  const add = useCallback((files: FileList | readonly File[]) => {
    const now = live.current
    const { accepted, refused } = checkImages(Array.from(files), now.images.length + now.pending.length)
    if (refused.length) onRefused(refused.join(' '))
    const added = accepted.map<PendingImage>((file) => ({
      key: crypto.randomUUID(), name: file.name, size: file.size, previewUrl: URL.createObjectURL(file), status: 'uploading',
    }))
    if (!added.length) return
    setPending((prev) => [...prev, ...added])
    added.forEach((item, i) => {
      uploadAttachment(accepted[i]).then(
        (uploaded) => {
          if (removed.current.has(item.key)) return
          URL.revokeObjectURL(item.previewUrl)
          setPending((prev) => prev.filter((p) => p.key !== item.key))
          setImages((prev) => [...prev, { id: uploaded.id, name: item.name, size: item.size }])
        },
        (err: unknown) => setPending((prev) => prev.map((p) => (p.key === item.key
          ? { ...p, status: 'error', error: err instanceof Error ? err.message : t('Upload failed') } : p))),
      )
    })
  }, [onRefused, setImages])

  const remove = useCallback((key: string) => {
    const gone = live.current.pending.find((p) => p.key === key)
    if (gone) {
      removed.current.add(key)
      URL.revokeObjectURL(gone.previewUrl)
      setPending((prev) => prev.filter((p) => p.key !== key))
    } else {
      setImages((prev) => prev.filter((i) => i.id !== key))
    }
  }, [setImages])

  /** Forget failed uploads (after a message was sent). */
  const clearFailed = useCallback(() => setPending((prev) => prev.filter((p) => p.status === 'uploading')), [])

  return {
    pending,
    add,
    remove,
    clearFailed,
    uploading: pending.some((p) => p.status === 'uploading'),
    count: images.length + pending.length,
  }
}

/**
 * Dropping images on a box and pasting them into its text: `dragging` while files are
 * held over it (to show it takes them), `box` for the element that takes the drop,
 * `onPaste` for the text field (text is pasted as always).
 */
export function useImageDrop(add: (files: FileList | File[]) => void, disabled = false) {
  const [dragging, setDragging] = useState(false)
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
  return {
    dragging,
    box: {
      onDragOver: (e: DragEvent) => {
        if (disabled || !hasFiles(e)) return
        e.preventDefault()
        setDragging(true)
      },
      onDragLeave: () => setDragging(false),
      onDrop: (e: DragEvent) => {
        setDragging(false)
        if (disabled || !e.dataTransfer.files.length) return
        e.preventDefault()
        add(e.dataTransfer.files)
      },
    },
    onPaste: (e: ClipboardEvent) => {
      if (disabled) return
      const files = pastedFiles(e.clipboardData)
      if (!files.length) return
      e.preventDefault()
      add(files)
    },
  }
}
