import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { cn } from '@/lib/cn'

interface SliderProps {
  value: number
  onChange: (value: number) => void
  /** Accessible name, e.g. "Volume". */
  label: string
  min?: number
  max?: number
  step?: number
  /** What a screen reader says for a value, e.g. "1:23 of 3:45" (default: the number). */
  valueText?: (value: number) => string
  /**
   * `live` (default) reports every change while dragging; `release` shows the new
   * position while dragging and reports it once, when let go (seeking in a track).
   */
  commit?: 'live' | 'release'
  disabled?: boolean
  /** `island` draws light on the Dynamic Island's dark background. */
  tone?: 'accent' | 'island'
  className?: string
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

/**
 * A horizontal slider: drag (mouse, pen or touch), click anywhere on the track, or use
 * the keyboard (arrows by one step, Page Up/Down by a tenth, Home/End to the ends).
 * The hit area is 20px tall, 44px on touch screens; the visible track stays thin.
 *
 *   <Slider label="Volume" value={volume} onChange={setVolume} />
 */
export function Slider({
  value,
  onChange,
  label,
  min = 0,
  max = 1,
  step = 0.01,
  valueText,
  commit = 'live',
  disabled,
  tone = 'accent',
  className,
}: SliderProps) {
  const ref = useRef<HTMLDivElement>(null)
  // While dragging with commit="release": where the thumb is, before it is reported.
  const [dragValue, setDragValue] = useState<number | null>(null)
  const shown = dragValue ?? value
  const span = max - min
  const pct = span > 0 ? clamp((shown - min) / span, 0, 1) : 0

  const snap = (v: number) => clamp(Math.round((v - min) / step) * step + min, min, max)

  function valueAt(e: PointerEvent) {
    const rect = ref.current!.getBoundingClientRect()
    const t = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0
    return snap(min + clamp(t, 0, 1) * span)
  }

  function update(v: number) {
    if (commit === 'release') setDragValue(v)
    else if (v !== value) onChange(v)
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (disabled || e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    update(valueAt(e))
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (disabled || !e.currentTarget.hasPointerCapture(e.pointerId)) return
    update(valueAt(e))
  }

  function onPointerUp() {
    if (dragValue !== null) {
      onChange(dragValue)
      setDragValue(null)
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (disabled) return
    const big = Math.max(step, span / 10)
    const next: Record<string, number> = {
      ArrowRight: value + step,
      ArrowUp: value + step,
      ArrowLeft: value - step,
      ArrowDown: value - step,
      PageUp: value + big,
      PageDown: value - big,
      Home: min,
      End: max,
    }
    if (!(e.key in next)) return
    e.preventDefault()
    e.stopPropagation()
    onChange(snap(next[e.key]))
  }

  const island = tone === 'island'
  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(shown * 1000) / 1000}
      aria-valuetext={valueText?.(shown)}
      aria-disabled={disabled || undefined}
      aria-orientation="horizontal"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDragValue(null)}
      onKeyDown={onKeyDown}
      className={cn(
        'group relative flex h-5 min-w-0 touch-none select-none items-center rounded-full pointer-coarse:h-11',
        disabled ? 'opacity-40' : 'cursor-pointer',
        // The focus ring goes around the track, not the whole (taller) hit area.
        'focus-visible:outline-none [&:focus-visible>span:first-child]:outline-2 [&:focus-visible>span:first-child]:outline-offset-2 [&:focus-visible>span:first-child]:outline-accent',
        className,
      )}
    >
      <span
        className={cn(
          'h-1.5 w-full overflow-hidden rounded-full transition-[height] duration-150 group-hover:h-2',
          island ? 'bg-island-track' : 'bg-border-strong',
        )}
      >
        <span
          className={cn('block h-full rounded-full', island ? 'bg-island-fg' : 'bg-accent')}
          style={{ width: `${pct * 100}%` }}
        />
      </span>
      <span
        aria-hidden
        className={cn(
          'absolute h-3.5 w-3.5 -translate-x-1/2 rounded-full bg-white shadow-soft ring-1 ring-border-strong transition-transform duration-150',
          // Always visible on touch screens and while in use; on hover otherwise.
          dragValue !== null ? 'scale-100' : 'scale-0 group-hover:scale-100 group-focus-visible:scale-100 pointer-coarse:scale-100',
        )}
        style={{ left: `${pct * 100}%` }}
      />
    </div>
  )
}
