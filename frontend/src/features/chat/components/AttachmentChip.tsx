import { AlertCircle, Download, Loader2, X } from 'lucide-react'
import { FileIcon } from '@/components/ui/FileIcon'
import { cn } from '@/lib/cn'
import { formatSize } from '@/lib/format'

interface ChipProps {
  name: string
  size: number
  /** image | pdf | document | spreadsheet | presentation | archive | text | file */
  kind?: string | null
  imageUrl?: string | null
  status?: 'uploading' | 'ready' | 'error'
  error?: string
  onRemove?: () => void
  /** Shown as a download (a file the agent made for you). */
  download?: boolean
}

/** A file shown in the composer (while uploading), on a sent message, or under an answer. */
export function AttachmentChip({ name, size, kind, imageUrl, status = 'ready', error, onRemove, download }: ChipProps) {
  return (
    <div
      title={error ?? (download ? `Download ${name}` : name)}
      className={cn(
        'group relative flex h-14 max-w-56 items-center gap-2.5 rounded-xl border bg-surface-2 pr-3',
        imageUrl ? 'pl-1' : 'pl-3',
        status === 'error' ? 'border-error/50' : 'border-border',
        download && 'transition-colors hover:border-accent/60 hover:bg-surface-hover',
      )}
    >
      {imageUrl ? (
        <img src={imageUrl} alt="" className="h-12 w-12 shrink-0 rounded-lg object-cover" />
      ) : (
        <FileIcon name={name} kind={kind} className="h-5 w-5 shrink-0 text-muted" />
      )}
      <div className="min-w-0">
        <div className="truncate text-[12.5px] font-medium">{name}</div>
        <div className={cn('flex items-center gap-1 text-[11px]', status === 'error' ? 'text-error' : 'text-muted')}>
          {status === 'uploading' && <Loader2 className="h-3 w-3 animate-spin" />}
          {status === 'error' && <AlertCircle className="h-3 w-3" />}
          {status === 'uploading' ? 'Uploading…' : status === 'error' ? (error ?? 'Failed') : formatSize(size)}
        </div>
      </div>
      {download && <Download className="ml-1 h-4 w-4 shrink-0 text-subtle group-hover:text-accent" />}
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
