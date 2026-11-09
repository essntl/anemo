import { useEffect, useState } from 'react'
import { AlertCircle, FileText, Loader2, X } from 'lucide-react'
import { cn } from '../lib/cn'
import { useSession } from '../state/useSession'
import { contentUrl, formatSize, type Pending } from './attachments'

/** A file waiting in the composer. */
export function PendingChip({ file, onRemove }: { file: Pending; onRemove: () => void }) {
  return (
    <div title={file.error ?? file.name} className={cn('group relative flex h-12 max-w-[11rem] items-center gap-2 rounded-xl border bg-surface-2 pr-2.5', file.preview ? 'pl-1' : 'pl-2.5', file.status === 'error' ? 'border-error/50' : 'border-border')} data-testid="pending-attachment">
      {file.preview ? <img src={file.preview} alt="" className="h-10 w-10 shrink-0 rounded-lg object-cover" /> : <FileText className="h-4 w-4 shrink-0 text-muted" />}
      <div className="min-w-0">
        <div className="truncate text-[12px] font-medium">{file.name}</div>
        <div className={cn('flex items-center gap-1 text-[11px]', file.status === 'error' ? 'text-error' : 'text-muted')}>
          {file.status === 'uploading' && <Loader2 className="h-3 w-3 animate-spin" />}
          {file.status === 'error' && <AlertCircle className="h-3 w-3 shrink-0" />}
          <span className="truncate">{file.status === 'uploading' ? 'Uploading…' : file.status === 'error' ? (file.error ?? 'Failed') : formatSize(file.size)}</span>
        </div>
      </div>
      <button type="button" aria-label={`Remove ${file.name}`} onClick={onRemove} className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-text text-bg opacity-0 focus:opacity-100 group-hover:opacity-100">
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}

/** A file on a sent message or under an answer: images show; a click opens the file. */
export function SentAttachment({ id, name, size, kind }: { id: string; name: string; size: number; kind: string }) {
  const { api } = useSession()
  const isImage = kind === 'image'
  const [thumb, setThumb] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!isImage) return
    let url: string | null = null
    let gone = false
    void contentUrl(api, id)
      .then((u) => {
        url = u
        if (gone) URL.revokeObjectURL(u)
        else setThumb(u)
      })
      .catch(() => undefined)
    return () => {
      gone = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [api, id, isImage])
  const open = async () => {
    setBusy(true)
    try {
      const url = thumb ?? (await contentUrl(api, id))
      const a = document.createElement('a')
      a.href = url
      if (isImage) a.target = '_blank'
      else a.download = name
      a.click()
    } finally {
      setBusy(false)
    }
  }
  return (
    <button type="button" onClick={() => void open()} title={isImage ? `Open ${name}` : `Download ${name}`} className={cn('flex h-12 max-w-[12rem] items-center gap-2 rounded-xl border border-border bg-surface pr-2.5 text-left hover:border-accent/60', thumb ? 'pl-1' : 'pl-2.5')} data-testid="attachment">
      {thumb ? <img src={thumb} alt="" className="h-10 w-10 shrink-0 rounded-lg object-cover" /> : busy ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted" /> : <FileText className="h-4 w-4 shrink-0 text-muted" />}
      <span className="min-w-0">
        <span className="block truncate text-[12px] font-medium">{name}</span>
        <span className="block text-[11px] text-muted">{formatSize(size)}</span>
      </span>
    </button>
  )
}
