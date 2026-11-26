/**
 * The images of a Claude Code prompt on the page (codeImages.ts): the chips in a box
 * (the chat's AttachmentChip, with a thumbnail and remove), the button that picks files,
 * and the thumbnails with a job's prompt in the thread. Dropping and pasting: useImageDrop
 * (codeImages.ts).
 */
import { useRef } from 'react'
import { ImagePlus } from 'lucide-react'
import { ZoomableImage } from '@/components/ui/ZoomableImage'
import { AttachmentChip } from '@/features/chat/components/AttachmentChip'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { type CodeImage, IMAGE_ACCEPT, MAX_IMAGES, type PendingImage, imageUrl } from './codeImages'

/** The images added to a box: uploaded ones and those still uploading (or failed). */
export function ImageChips({ images, pending, onRemove, className }: {
  images: readonly CodeImage[]; pending: readonly PendingImage[]; onRemove: (key: string) => void; className?: string
}) {
  if (!images.length && !pending.length) return null
  return (
    <div data-testid="code-images" className={cn('flex flex-wrap gap-2', className)}>
      {images.map((image) => (
        <AttachmentChip key={image.id} name={image.name} size={image.size} kind="image" imageUrl={imageUrl(image.id)}
          onRemove={() => onRemove(image.id)} />
      ))}
      {pending.map((p) => (
        <AttachmentChip key={p.key} name={p.name} size={p.size} kind="image" imageUrl={p.previewUrl}
          status={p.status} error={p.error} onRemove={() => onRemove(p.key)} />
      ))}
    </div>
  )
}

/** The button that picks images (the same files can also be dropped or pasted). */
export function AddImagesButton({ onFiles, count, disabled, className }: {
  onFiles: (files: FileList) => void; count: number; disabled?: boolean; className?: string
}) {
  const input = useRef<HTMLInputElement>(null)
  const full = count >= MAX_IMAGES
  const label = full ? t('At most {n} images can go with one message.', { n: MAX_IMAGES }) : t('Add images')
  return (
    <>
      <button type="button" aria-label={t('Add images')} title={label} disabled={disabled || full}
        onClick={() => input.current?.click()}
        className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:h-10 pointer-coarse:w-10', className)}>
        <ImagePlus className="h-4.5 w-4.5" />
      </button>
      <input ref={input} type="file" accept={IMAGE_ACCEPT} multiple hidden data-testid="code-image-input"
        onChange={(e) => {
          if (e.target.files?.length) onFiles(e.target.files)
          e.target.value = ''
        }} />
    </>
  )
}

/** The images that went with a job's prompt (or a queued message), small; a tap shows one large. */
export function PromptImages({ images, className }: { images: readonly { id: string; name: string }[]; className?: string }) {
  if (!images.length) return null
  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {images.map((image) => (
        <ZoomableImage key={image.id} src={imageUrl(image.id)} alt={image.name} title={image.name} filename={image.name}
          className="h-16 w-16 rounded-lg border border-border object-cover" />
      ))}
    </div>
  )
}
