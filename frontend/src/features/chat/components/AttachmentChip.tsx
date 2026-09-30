import { AlertCircle, FileText, Loader2, X } from 'lucide-react'
import { cn } from '@/lib/cn'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

interface ChipProps {
  name: string
  size: number
  imageUrl?: string | null
  status?: 'uploading' | 'ready' | 'error'
  error?: string
  onRemove?: () => void
}

/** A file shown in the composer (while uploading) or on a sent message. */
export function AttachmentChip({ name, size, imageUrl, status = 'ready', error, onRemove }: ChipProps) {
  return (
    <div
      title={error ?? name}
      className={cn(
        'group relative flex h-14 max-w-56 items-center gap-2.5 rounded-xl border bg-surface-2 pr-3',
        imageUrl ? 'pl-1' : 'pl-3',
        status === 'error' ? 'border-error/50' : 'border-border',
      )}
    >
      {imageUrl ? (
        <img src={imageUrl} alt="" className="h-12 w-12 shrink-0 rounded-lg object-cover" />
      ) : (
        <FileText className="h-5 w-5 shrink-0 text-muted" />
      )}
      <div className="min-w-0">
        <div className="truncate text-[12.5px] font-medium">{name}</div>
        <div className={cn('flex items-center gap-1 text-[11px]', status === 'error' ? 'text-error' : 'text-muted')}>
          {status === 'uploading' && <Loader2 className="h-3 w-3 animate-spin" />}
          {status === 'error' && <AlertCircle className="h-3 w-3" />}
          {status === 'uploading' ? 'Uploading…' : status === 'error' ? (error ?? 'Failed') : formatSize(size)}
        </div>
      </div>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${name}`}
          onClick={onRemove}
          className="absolute -right-1.5 -top-1.5 hidden h-5 w-5 items-center justify-center rounded-full bg-text text-bg group-hover:flex"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  )
}
