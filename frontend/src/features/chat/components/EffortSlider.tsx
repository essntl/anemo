import { type CSSProperties, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import type { ReasoningEffort } from '../api'
import { EFFORT_LEVELS } from '../reasoning'

const LAST = EFFORT_LEVELS.length - 1
const clamp = (v: number) => Math.min(LAST, Math.max(0, v))

// Where the sparks of "max" fly off to, sideways (px), and when each starts (s).
const SPARKS = [
  { dx: -9, delay: 0 },
  { dx: 6, delay: 0.25 },
  { dx: -3, delay: 0.55 },
  { dx: 10, delay: 0.8 },
  { dx: -11, delay: 1.05 },
  { dx: 2, delay: 1.25 },
]

/**
 * The reasoning effort slider: five stops from Off to Max. Drag the thumb (mouse, pen or
 * touch), tap a stop or its name, or use the keyboard (arrows, Page Up/Down, Home/End).
 * A drag shows where it is going and is reported once, when let go.
 *
 * The fill heats up as it rises, and the effects build with the level (app.css,
 * "reasoning effort"): a glow from Medium, a light sweeping along it at High, and at Max
 * a faster sweep, a halo breathing round the thumb and sparks rising from it.
 */
export function EffortSlider({
  value,
  onChange,
  disabled,
}: {
  value: ReasoningEffort
  onChange: (level: ReasoningEffort) => void
  disabled?: boolean
}) {
  const track = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<number | null>(null)
  const index = Math.max(0, EFFORT_LEVELS.findIndex((l) => l.id === value))
  const shown = drag ?? index
  const level = EFFORT_LEVELS[shown]
  const pct = (shown / LAST) * 100

  function stopAt(e: PointerEvent) {
    const rect = track.current!.getBoundingClientRect()
    return clamp(Math.round(rect.width > 0 ? ((e.clientX - rect.left) / rect.width) * LAST : 0))
  }

  function moveTo(next: number, e: PointerEvent) {
    // A light tick on phones as the thumb passes each stop.
    if (next !== shown && e.pointerType === 'touch') navigator.vibrate?.(8)
    setDrag(next)
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (disabled || e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    moveTo(stopAt(e), e)
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (disabled || !e.currentTarget.hasPointerCapture(e.pointerId)) return
    moveTo(stopAt(e), e)
  }

  function onPointerUp() {
    if (drag === null) return
    if (drag !== index) onChange(EFFORT_LEVELS[drag].id)
    setDrag(null)
  }

  function onKeyDown(e: KeyboardEvent) {
    if (disabled) return
    const next: Record<string, number> = {
      ArrowRight: index + 1,
      ArrowUp: index + 1,
      ArrowLeft: index - 1,
      ArrowDown: index - 1,
      PageUp: index + 2,
      PageDown: index - 2,
      Home: 0,
      End: LAST,
    }
    if (!(e.key in next)) return
    e.preventDefault()
    e.stopPropagation()
    const to = clamp(next[e.key])
    if (to !== index) onChange(EFFORT_LEVELS[to].id)
  }

  // The fill and its glow show up to the thumb. The glow may spill above and below.
  const clip = `inset(0 ${100 - pct}% 0 0 round 9999px)`
  const glowClip = `inset(-14px ${100 - pct}% -14px -14px)`
  return (
    <div
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={t('Reasoning effort')}
      aria-valuemin={0}
      aria-valuemax={LAST}
      aria-valuenow={shown}
      aria-valuetext={`${t(level.label)}: ${t(level.hint)}`}
      aria-disabled={disabled || undefined}
      aria-orientation="horizontal"
      data-level={level.id}
      data-dragging={drag !== null || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
      onKeyDown={onKeyDown}
      className={cn(
        'effort group relative touch-none select-none rounded-control px-4 pb-1 pt-3 outline-none',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        disabled ? 'opacity-40' : 'cursor-pointer',
      )}
    >
      <div ref={track} className="relative h-2.5 rounded-full bg-surface-2 shadow-[inset_0_1px_2px_color-mix(in_oklch,var(--text)_14%,transparent)] pointer-coarse:h-3">
        <span aria-hidden className="effort-glow" style={{ clipPath: glowClip }} />
        <span aria-hidden className="effort-fill" style={{ clipPath: clip }}>
          <span className="effort-sheen" />
        </span>
        {EFFORT_LEVELS.map((l, i) => (
          <span
            key={l.id}
            aria-hidden
            className={cn(
              'absolute top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors duration-200',
              i === 0 || i === LAST ? 'opacity-0' : i <= shown ? 'bg-accent-contrast/70' : 'bg-border-strong',
            )}
            style={{ left: `${(i / LAST) * 100}%` }}
          />
        ))}
        {/* The rail is as wide as the track, so moving it by pct% puts the thumb on the stop. */}
        <span aria-hidden className="effort-rail" style={{ transform: `translateX(${pct}%)` }}>
          <span className="effort-thumb">
            <span className="effort-halo" />
            <span className="effort-sparks">
              {SPARKS.map((s, i) => (
                <span key={i} style={{ '--dx': `${s.dx}px`, animationDelay: `${s.delay}s` } as CSSProperties} />
              ))}
            </span>
            <span className="effort-core" />
          </span>
        </span>
      </div>
      {/* The names of the stops, each under its stop (a tap there picks it). */}
      <div aria-hidden className="relative mt-2.5 h-4 text-[11px] leading-4">
        {EFFORT_LEVELS.map((l, i) => (
          <span
            key={l.id}
            className={cn(
              'absolute -translate-x-1/2 whitespace-nowrap transition-colors duration-200',
              i === shown ? 'font-semibold text-text' : 'text-subtle',
            )}
            style={{ left: `${(i / LAST) * 100}%` }}
          >
            {t(l.label)}
          </span>
        ))}
      </div>
    </div>
  )
}
