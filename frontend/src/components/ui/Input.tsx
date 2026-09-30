import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          'h-10 w-full rounded-control border border-border bg-surface px-3 text-sm',
          'placeholder:text-subtle focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft',
          'disabled:opacity-60',
          className,
        )}
        {...rest}
      />
    )
  },
)

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium">{label}</span>
      {children}
      {error ? (
        <span className="mt-1 block text-[12px] text-error">{error}</span>
      ) : (
        hint && <span className="mt-1 block text-[12px] text-muted">{hint}</span>
      )}
    </label>
  )
}
