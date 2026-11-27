import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

const TONES = {
  /** Something to look at (suggestions waiting). */
  accent: 'text-accent',
  /** Something to fix (broken links). */
  warning: 'text-warning',
}

/**
 * A slim notice above a list that opens something when clicked ("3 broken links",
 * "2 suggested property changes to review"). Quiet on purpose: a thin outline and muted
 * text, so it doesn't outweigh the list; only its icon carries the tone.
 */
export function NoticeButton({ icon, tone = 'accent', onClick, className, children }: {
  icon: ReactNode
  tone?: keyof typeof TONES
  onClick: () => void
  className?: string
  children: ReactNode
}) {
  return (
    <button type="button" onClick={onClick}
      className={cn(
        'mx-3 mt-2 flex min-h-8 w-[calc(100%-1.5rem)] items-center gap-2 rounded-control border border-border px-2.5 py-1 text-left text-[12px] font-medium text-muted transition-colors',
        'hover:bg-surface-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft pointer-coarse:min-h-10',
        className,
      )}>
      <span aria-hidden className={cn('flex shrink-0 [&>svg]:h-3.5 [&>svg]:w-3.5', TONES[tone])}>{icon}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </button>
  )
}
