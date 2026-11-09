import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { cn } from '../lib/cn'

const field =
  'w-full rounded-control border border-border bg-surface px-3 text-[13.5px] placeholder:text-subtle ' +
  'focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft disabled:opacity-60'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(field, 'h-9', className)} {...rest} />
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(field, 'block py-2 leading-relaxed', className)} {...rest} />
})

/** A labelled control. The label is tied to the first input inside via `htmlFor`/`id`. */
export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: ReactNode; children: (id: string) => ReactNode }) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[12.5px] font-medium">{label}</label>
      {children(id)}
      {error ? <p className="text-[12px] text-error">{error}</p> : hint ? <p className="text-[12px] text-muted">{hint}</p> : null}
    </div>
  )
}
