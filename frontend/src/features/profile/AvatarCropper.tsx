/**
 * Choosing the square of a picture that becomes the avatar: drag the picture (or use
 * the arrow keys), zoom with the slider (or + and −). Only the crop box is worked out
 * here; the server crops and resizes the original (features/appearance/files.py), so
 * what is sent is the file as chosen plus fractions of its size.
 */
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Slider } from '@/components/ui/Slider'
import type { CropBox } from '@/features/appearance/api'
import { clampCrop, cropSide, type CropState, MAX_ZOOM, toCropBox, zoomTo } from './crop'
import { t } from '@/lib/i18n'

const VIEW = 240 // px, the square shown

interface Props {
  /** The picture chosen, and an object URL of it (made and revoked by the caller). */
  file: File | null
  url: string | null
  onCancel: () => void
  onDone: (file: File, crop: CropBox) => void
  saving?: boolean
}

export function AvatarCropper({ file, url, onCancel, onDone, saving }: Props) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [crop, setCrop] = useState<CropState>({ x: 0, y: 0, zoom: 1 })
  const drag = useRef<{ x: number; y: number; start: CropState } | null>(null)

  const onLoad = (img: HTMLImageElement) => {
    const w = img.naturalWidth
    const h = img.naturalHeight
    setSize({ w, h })
    // Start with the largest square in the middle.
    const side = Math.min(w, h)
    setCrop({ zoom: 1, x: (w - side) / 2, y: (h - side) / 2 })
  }

  const scale = size ? VIEW / cropSide(size.w, size.h, crop.zoom) : 1
  const update = (next: CropState) => size && setCrop(clampCrop(size.w, size.h, next))

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, start: crop }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    update({ ...d.start, x: d.start.x - (e.clientX - d.x) / scale, y: d.start.y - (e.clientY - d.y) / scale })
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!size) return
    const step = cropSide(size.w, size.h, crop.zoom) * 0.05
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
    }
    if (e.key in moves) {
      const [dx, dy] = moves[e.key]
      update({ ...crop, x: crop.x + dx, y: crop.y + dy })
    } else if (e.key === '+' || e.key === '=') {
      setCrop(zoomTo(size.w, size.h, crop, Math.min(MAX_ZOOM, crop.zoom + 0.25)))
    } else if (e.key === '-') {
      setCrop(zoomTo(size.w, size.h, crop, Math.max(1, crop.zoom - 0.25)))
    } else {
      return
    }
    e.preventDefault()
  }

  return (
    <Dialog open={file !== null} onOpenChange={(open) => !open && onCancel()} title={t('Crop your avatar')}
      description={t('Drag the picture or use the arrow keys; zoom with the slider or + and −.')}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>{t('Cancel')}</Button>
          <Button variant="primary" disabled={!size} loading={saving}
            onClick={() => file && size && onDone(file, toCropBox(size.w, size.h, crop))}>
            {t('Save avatar')}
          </Button>
        </>
      }>
      <div className="flex flex-col items-center gap-4">
        <div role="group" tabIndex={0} aria-label={t('Avatar crop area')}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)} onKeyDown={onKeyDown} data-testid="avatar-crop-area"
          className="relative touch-none overflow-hidden rounded-full bg-surface-2 ring-1 ring-border"
          style={{ width: VIEW, height: VIEW, cursor: 'grab' }}>
          {url && (
            <img src={url} alt="" draggable={false} onLoad={(e) => onLoad(e.currentTarget)}
              className="pointer-events-none absolute left-0 top-0 max-w-none select-none"
              style={size ? {
                width: size.w * scale,
                height: size.h * scale,
                transform: `translate(${-crop.x * scale}px, ${-crop.y * scale}px)`,
              } : { visibility: 'hidden' }} />
          )}
        </div>
        <div className="flex w-full max-w-[240px] items-center gap-3">
          <span className="text-[12.5px] text-muted">{t('Zoom')}</span>
          <Slider label={t('Zoom')} min={1} max={MAX_ZOOM} step={0.05} value={crop.zoom} className="flex-1"
            valueText={(v) => `${v.toFixed(1)}×`} disabled={!size}
            onChange={(v) => size && setCrop(zoomTo(size.w, size.h, crop, v))} />
        </div>
      </div>
    </Dialog>
  )
}
