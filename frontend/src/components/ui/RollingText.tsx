import { AnimatePresence, motion } from 'motion/react'
import { cn } from '@/lib/cn'

/**
 * Text whose characters roll when they change (the timer's clock). Each character
 * has its own slot, so only the digits that change move. With reduced motion they
 * just fade. Screen readers get the plain text.
 */
export function RollingText({ value, className }: { value: string; className?: string }) {
  return (
    <span className={cn('inline-flex tabular-nums', className)}>
      <span className="sr-only">{value}</span>
      {value.split('').map((ch, i) => (
        // Keyed by position from the right, so 9:59 → 10:00 keeps the seconds in place.
        <span key={value.length - i} aria-hidden className="relative inline-block overflow-hidden">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={ch}
              initial={{ y: '-70%', opacity: 0 }}
              animate={{ y: '0%', opacity: 1 }}
              exit={{ y: '70%', opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="inline-block"
            >
              {ch}
            </motion.span>
          </AnimatePresence>
        </span>
      ))}
    </span>
  )
}
