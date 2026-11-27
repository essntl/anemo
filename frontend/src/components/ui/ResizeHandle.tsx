import { useRef, type PointerEvent } from 'react'
import type { ResizableWidth } from '@/hooks/useResizableWidth'
import { cn } from '@/lib/cn'

const STEP = 16 // px per arrow key press

/**
 * The edge of a panel to drag (`useResizableWidth`): on the right edge of the panel it
 * is placed in (the panel needs `relative`). Arrow keys move it too; a double-click goes
 * back to the default width.
 */
export function ResizeHandle({ size, label, className }: { size: ResizableWidth; label: string; className?: string }) {
  const start = useRef<{ x: number; width: number } | null>(null)
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    start.current = { x: e.clientX, width: size.width }
  }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (start.current) size.setWidth(start.current.width + e.clientX - start.current.x, false)
  }
  const up = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return
    size.setWidth(start.current.width + e.clientX - start.current.x)
    start.current = null
  }
  return (
    <div role="separator" aria-orientation="vertical" aria-label={label} tabIndex={0}
      aria-valuenow={size.width} aria-valuemin={size.min} aria-valuemax={size.max}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      onDoubleClick={size.reset}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault()
          size.setWidth(size.width + (e.key === 'ArrowLeft' ? -STEP : STEP))
        }
      }}
      className={cn(
        'absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize touch-none select-none',
        'after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent after:transition-colors',
        'hover:after:bg-accent focus-visible:outline-none focus-visible:after:bg-accent',
        className,
      )} />
  )
}
