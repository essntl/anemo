/** The zoom controls in the corner of the sketch canvas: out, the zoom (back to 100 %), in, fit. */
import { Maximize, Minus, Plus } from 'lucide-react'
import { shortcutText } from '@/features/shortcuts/registry'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { MAX_ZOOM, MIN_ZOOM } from './viewport'

const BUTTON =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-muted transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-35 pointer-coarse:h-10 pointer-coarse:w-10 [&_svg]:h-4 [&_svg]:w-4'

export function SketchZoom({ zoom, onZoomIn, onZoomOut, onReset, onFit, className }: {
  zoom: number
  onZoomIn: () => void
  onZoomOut: () => void
  onReset: () => void
  onFit: () => void
  className?: string
}) {
  return (
    <div role="group" aria-label={t('Zoom')} className={cn('flex items-center gap-0.5 rounded-panel border border-border bg-card p-1 shadow-soft', className)}>
      <button type="button" className={BUTTON} aria-label={t('Zoom out')} title={`${t('Zoom out')} (${shortcutText('sketch.zoomOut')})`}
        disabled={zoom <= MIN_ZOOM + 1e-6} onClick={onZoomOut}>
        <Minus />
      </button>
      <button type="button" onClick={onReset} title={t('Back to 100 %')} aria-label={t('Zoom {percent}%, back to 100 %', { percent: Math.round(zoom * 100) })}
        className="h-8 min-w-12 rounded-control px-1 text-[12px] font-medium tabular-nums text-muted hover:bg-surface-hover hover:text-text pointer-coarse:h-10">
        {Math.round(zoom * 100)}%
      </button>
      <button type="button" className={BUTTON} aria-label={t('Zoom in')} title={`${t('Zoom in')} (${shortcutText('sketch.zoomIn')})`}
        disabled={zoom >= MAX_ZOOM - 1e-6} onClick={onZoomIn}>
        <Plus />
      </button>
      <button type="button" className={BUTTON} aria-label={t('Fit the drawing to the window')} title={`${t('Fit the drawing to the window')} (${shortcutText('sketch.fit')})`} onClick={onFit}>
        <Maximize />
      </button>
    </div>
  )
}
