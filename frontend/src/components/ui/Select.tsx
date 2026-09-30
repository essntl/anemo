import { forwardRef, type SelectHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

/** Native select styled to match inputs (keeps keyboard/a11y behaviour for free). */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, ...rest }, ref) {
    return (
      <select
        ref={ref}
        className={cn(
          'h-10 w-full rounded-control border border-border bg-surface px-3 text-sm',
          'focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft disabled:opacity-60',
          className,
        )}
        {...rest}
      />
    )
  },
)
