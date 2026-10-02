import type { InputHTMLAttributes } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/cn'

/**
 * A checkbox in the app's own style (the browser's default one ignores the theme).
 * It is still a real <input type="checkbox">, so labels, keyboard and forms work as usual.
 *
 *   <Checkbox checked={on} onChange={(e) => setOn(e.target.checked)} aria-label="Select all" />
 */
export function Checkbox({ className, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  return (
    <span className={cn('relative inline-flex h-[18px] w-[18px] shrink-0 pointer-coarse:h-5 pointer-coarse:w-5', className)}>
      <input
        type="checkbox"
        className={cn(
          'peer h-full w-full cursor-pointer appearance-none rounded-md border border-border-strong bg-surface transition-colors',
          'hover:border-accent checked:border-accent checked:bg-accent',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft',
          'disabled:cursor-default disabled:opacity-50 disabled:hover:border-border-strong',
        )}
        {...rest}
      />
      <Check strokeWidth={3}
        className="pointer-events-none absolute inset-0 m-auto hidden h-3 w-3 text-accent-contrast peer-checked:block" />
    </span>
  )
}
