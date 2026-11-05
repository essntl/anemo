/**
 * A diagram or chart full screen: zoom with the wheel, the buttons or + / − / 0, and
 * move it by dragging. Esc or the close button closes it.
 */
import { useRef, useState, type PointerEvent, type ReactNode, type WheelEvent } from 'react'
import * as RadixDialog from '@radix-ui/react-dialog'
import { Maximize2, Minus, Plus, X } from 'lucide-react'

const MIN = 0.25
const MAX = 8

const button =
  'flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface text-muted shadow-soft hover:bg-surface-hover hover:text-text [&_svg]:h-4 [&_svg]:w-4'

export function DiagramViewer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null)
  const stage = useRef<HTMLDivElement>(null)

  /** Zooms by `factor` around a point of the stage (its centre by default). */
  const zoom = (factor: number, at?: { x: number; y: number }) =>
    setView((v) => {
      const scale = Math.min(MAX, Math.max(MIN, v.scale * factor))
      const rect = stage.current?.getBoundingClientRect()
      const px = at && rect ? at.x - rect.left - rect.width / 2 : 0
      const py = at && rect ? at.y - rect.top - rect.height / 2 : 0
      const k = scale / v.scale
      return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k }
    })
  const reset = () => setView({ scale: 1, x: 0, y: 0 })

  const onWheel = (e: WheelEvent) => zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, { x: e.clientX, y: e.clientY })
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    drag.current = { x: view.x, y: view.y, startX: e.clientX, startY: e.clientY }
  }
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current
    if (d) setView((v) => ({ ...v, x: d.x + e.clientX - d.startX, y: d.y + e.clientY - d.startY }))
  }
  const onPointerUp = () => {
    drag.current = null
  }

  return (
    <RadixDialog.Root open onOpenChange={(open) => !open && onClose()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-bg/95 backdrop-blur-sm" />
        <RadixDialog.Content aria-describedby={undefined}
          className="fixed inset-0 z-50 flex flex-col focus:outline-none"
          onKeyDown={(e) => {
            if (e.key === '+' || e.key === '=') zoom(1.25)
            else if (e.key === '-') zoom(1 / 1.25)
            else if (e.key === '0') reset()
          }}>
          <div className="flex items-center gap-2 px-4 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))]">
            <RadixDialog.Title className="min-w-0 flex-1 truncate text-[14px] font-medium">{title}</RadixDialog.Title>
            <span className="w-12 text-right text-[12px] tabular-nums text-muted">{Math.round(view.scale * 100)}%</span>
            <button type="button" className={button} onClick={() => zoom(1 / 1.25)} aria-label="Zoom out" title="Zoom out (−)"><Minus /></button>
            <button type="button" className={button} onClick={() => zoom(1.25)} aria-label="Zoom in" title="Zoom in (+)"><Plus /></button>
            <button type="button" className={button} onClick={reset} aria-label="Fit to window" title="Fit to window (0)"><Maximize2 /></button>
            <RadixDialog.Close className={button} aria-label="Close" title="Close (Esc)"><X /></RadixDialog.Close>
          </div>
          <div ref={stage} data-testid="diagram-stage"
            className="relative flex min-h-0 flex-1 cursor-grab touch-none items-center justify-center overflow-hidden active:cursor-grabbing"
            onWheel={onWheel} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
            <div className="max-h-full max-w-full p-6 [&_svg]:h-auto [&_svg]:max-h-[calc(100dvh-7rem)] [&_svg]:max-w-[calc(100vw-3rem)]"
              style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, transformOrigin: 'center' }}>
              {children}
            </div>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}
