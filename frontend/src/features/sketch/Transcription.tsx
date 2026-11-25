import { AlertTriangle, Loader2, ScanText } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { t } from '@/lib/i18n'
import type { SketchState } from './api'

/**
 * The text a model read from the drawing, in the panel beside the sketch. It is derived
 * (and may be wrong), so it says so; it is shown as plain text, never as Markdown.
 */
export function Transcription({ sketch, busy, onTranscribe }: {
  sketch: SketchState | null | undefined
  busy: boolean
  onTranscribe: () => void
}) {
  const queued = sketch?.transcription_status === 'queued'
  const failed = sketch?.transcription_status === 'failed'
  const text = sketch?.transcription?.trim()
  const unreadable = !sketch?.data
  return (
    <section aria-label={t('Text in the drawing')} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
      {queued ? (
        <p role="status" className="flex items-center gap-2 px-1 text-[13px] text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> {t('Reading the drawing…')}
        </p>
      ) : failed ? (
        <p role="alert" className="flex items-start gap-2 px-1 text-[13px] text-error">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {t('The drawing could not be read. Try again, or with another model.')}
        </p>
      ) : null}

      {text ? (
        <div>
          <p className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-subtle">{t('Read from the drawing by a model')}</p>
          {!sketch?.transcription_current && (
            <p className="mb-2 flex items-start gap-1.5 rounded-control bg-warning/8 px-2 py-1.5 text-[12.5px] text-warning">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {t('Made from an earlier version of the drawing.')}
            </p>
          )}
          <p className="whitespace-pre-wrap break-words rounded-control border border-border bg-surface-2 px-3 py-2 text-[13px] leading-relaxed">{text}</p>
        </div>
      ) : !queued && (
        <p className="px-1 text-[13px] leading-relaxed text-muted">
          {t('A model that can see images can read the drawing: handwriting, labels, a diagram. The text then shows here, and search and agents can find the sketch by it.')}
        </p>
      )}

      {!queued && (
        <div>
          <Button size="sm" variant={text && sketch?.transcription_current ? 'ghost' : 'secondary'} icon={<ScanText className="h-4 w-4" />}
            loading={busy} disabled={unreadable} onClick={onTranscribe}>
            {text ? t('Transcribe again') : t('Transcribe')}
          </Button>
        </div>
      )}
    </section>
  )
}
