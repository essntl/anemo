import { memo } from 'react'
import { cn } from '@/lib/cn'

const RESTING = [0.9, 0.5, 0.75, 0.6]

/**
 * "Now playing" bars in the current text colour. CSS animation, not `motion`: inside
 * dragged or layout-animated rows (the queue) motion resets child transforms, which
 * would freeze the bars. Still with reduced motion (styles/app.css).
 */
export const Equalizer = memo(function Equalizer({ playing, className }: { playing: boolean; className?: string }) {
  return (
    <span className={cn('inline-flex h-3.5 items-end gap-[2px]', className)} aria-hidden>
      {RESTING.map((h, i) => (
        <span key={i} className="eq-bar h-full w-[3px] rounded-full bg-current transition-transform duration-300"
          style={playing ? { animation: `eq-bar ${0.9 + i * 0.17}s ease-in-out ${i * 0.08}s infinite` } : { transform: `scaleY(${h * 0.4})` }} />
      ))}
    </span>
  )
})
