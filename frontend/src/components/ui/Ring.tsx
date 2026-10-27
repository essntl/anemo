import { cn } from '@/lib/cn'

/**
 * A circular progress ring (the timer). `color` and `track` are CSS colours, normally
 * tokens: `var(--phase-focus)`, `var(--island-track)`.
 */
export function Ring({
  progress,
  size = 20,
  stroke = 3,
  color = 'var(--accent)',
  track = 'var(--border-strong)',
  className,
}: {
  progress: number
  size?: number
  stroke?: number
  color?: string
  track?: string
  className?: string
}) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const p = Math.min(1, Math.max(0, progress))
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={cn('shrink-0 -rotate-90', className)} aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - p)}
        className="transition-[stroke-dashoffset,stroke] duration-300 ease-linear motion-reduce:transition-none"
      />
    </svg>
  )
}
