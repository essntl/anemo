import { useState } from 'react'
import { PenLine } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Dialog } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { formatWhen } from '@/lib/format'
import { t } from '@/lib/i18n'
import { type DocumentSummary, useDocuments } from '@/features/documents/api'

const MAX_SHOWN = 50 // the search narrows it down

/**
 * Pick one of the sketches in Documents, found by its title or file (to attach its image
 * to a message, or embed it in a document).
 */
export function SketchPickerDialog({ onPick, onClose, title, description }: {
  onPick: (sketch: DocumentSummary) => void
  onClose: () => void
  title?: string
  description?: string
}) {
  const documents = useDocuments()
  const [search, setSearch] = useState('')
  const q = search.trim().toLowerCase()
  const sketches = (documents.data?.documents ?? []).filter((d) => d.kind === 'sketch')
  const shown = sketches.filter((d) => !q || d.title.toLowerCase().includes(q) || d.path.toLowerCase().includes(q)).slice(0, MAX_SHOWN)
  const pick = (sketch: DocumentSummary) => {
    onPick(sketch)
    onClose()
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={title ?? t('Attach a sketch')} className="md:w-[min(92vw,480px)]"
      description={description ?? t('Its image goes with the message, as it looks now.')}>
      <Input value={search} autoFocus placeholder={t('Find a sketch by title')} aria-label={t('Find a sketch by title')}
        onChange={(e) => setSearch(e.target.value)} />
      <div className="mt-3 max-h-[45dvh] overflow-y-auto rounded-control border border-border">
        {documents.isPending && <p className="p-4 text-[13px] text-muted">{t('Loading…')}</p>}
        {documents.error && <p className="p-4 text-[13px] text-error">{errorMessage(documents.error)}</p>}
        {documents.isSuccess && shown.length === 0 && (
          <p className="p-4 text-[13px] text-muted">{sketches.length === 0 ? t('No sketches yet. Make one in Documents with New sketch.') : t('Nothing matches.')}</p>
        )}
        {shown.map((d) => (
          <button key={d.id} type="button" onClick={() => pick(d)}
            className="flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left last:border-b-0 hover:bg-surface-hover">
            <PenLine className="h-4 w-4 shrink-0 text-muted" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-medium">{d.title}</span>
              <span className="block truncate text-[11.5px] text-muted">{formatWhen(d.updated_at)} · {d.path}</span>
            </span>
          </button>
        ))}
      </div>
    </Dialog>
  )
}
