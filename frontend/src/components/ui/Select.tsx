import type { ReactNode } from 'react'
import * as RadixSelect from '@radix-ui/react-select'
import { Check, ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '@/lib/cn'

export interface SelectOption {
  value: string
  label: ReactNode
  disabled?: boolean
}

interface SelectProps {
  value: string
  onValueChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  disabled?: boolean
  id?: string
  className?: string
  'aria-label'?: string
  /** `field` looks like an input (forms); `ghost` is a compact text button (toolbars);
   *  `pill` is a small rounded filter that is only as wide as its text. */
  variant?: keyof typeof VARIANTS
}

const VARIANTS = {
  field: 'h-10 w-full rounded-control border border-border bg-surface px-3 text-sm hover:border-border-strong data-[state=open]:border-border-strong focus:border-accent focus:ring-2 focus:ring-accent-soft pointer-coarse:h-11',
  ghost: 'h-8 rounded-lg px-2 text-[12.5px] text-muted hover:bg-surface-hover hover:text-text data-[state=open]:bg-surface-hover pointer-coarse:h-10',
  pill: 'h-8 max-w-[11rem] gap-1 rounded-full border border-transparent bg-surface-2 pl-3 pr-2 text-[12.5px] hover:bg-surface-hover data-[state=open]:bg-surface-hover focus:border-accent focus:ring-2 focus:ring-accent-soft pointer-coarse:h-9',
}

// Radix reserves "" for "nothing selected", but "" is a handy "use the default"
// value in our forms, so it is swapped for this placeholder internally.
const EMPTY = '__empty__'
const toRadix = (v: string) => (v === '' ? EMPTY : v)
const fromRadix = (v: string) => (v === EMPTY ? '' : v)

/**
 * A dropdown styled like the rest of the app (the browser's own <select> list
 * can't be styled). Built on Radix Select: keyboard, typeahead and screen readers work.
 *
 *   <Select value={mode} onValueChange={setMode} options={[{ value: 'chat', label: 'Chat' }]} />
 */
export function Select({
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  id,
  className,
  variant = 'field',
  'aria-label': ariaLabel,
}: SelectProps) {
  return (
    <RadixSelect.Root value={toRadix(value)} onValueChange={(v) => onValueChange(fromRadix(v))} disabled={disabled}>
      <RadixSelect.Trigger
        id={id}
        aria-label={ariaLabel}
        className={cn(
          'group inline-flex min-w-0 items-center justify-between gap-2 text-left focus:outline-none disabled:opacity-60',
          'data-[placeholder]:text-subtle',
          VARIANTS[variant],
          className,
        )}
      >
        <span className="min-w-0 truncate">
          <RadixSelect.Value placeholder={placeholder} />
        </span>
        <RadixSelect.Icon>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-60 transition-transform group-data-[state=open]:rotate-180" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={6}
          collisionPadding={12}
          className={cn(
            'pop z-50 min-w-[var(--radix-select-trigger-width)] max-w-[min(26rem,calc(100vw-24px))]',
            'max-h-[min(22rem,var(--radix-select-content-available-height))] overflow-hidden',
            'rounded-card border border-border bg-card shadow-float',
          )}
        >
          <RadixSelect.ScrollUpButton className="flex h-6 items-center justify-center text-muted">
            <ChevronUp className="h-4 w-4" />
          </RadixSelect.ScrollUpButton>
          <RadixSelect.Viewport className="p-1.5">
            {options.map((o) => (
              <RadixSelect.Item
                key={o.value}
                value={toRadix(o.value)}
                disabled={o.disabled}
                data-value={o.value}
                className={cn(
                  'relative flex cursor-pointer select-none items-center gap-2 rounded-control py-2 pl-8 pr-3 text-[13.5px] outline-none',
                  'data-[highlighted]:bg-surface-hover data-[state=checked]:font-medium data-[state=checked]:text-accent',
                  'data-[disabled]:cursor-default data-[disabled]:opacity-50 pointer-coarse:py-3 pointer-coarse:text-[15px]',
                )}
              >
                <RadixSelect.ItemIndicator className="absolute left-2.5 inline-flex">
                  <Check className="h-4 w-4" />
                </RadixSelect.ItemIndicator>
                <RadixSelect.ItemText>{o.label}</RadixSelect.ItemText>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
          <RadixSelect.ScrollDownButton className="flex h-6 items-center justify-center text-muted">
            <ChevronDown className="h-4 w-4" />
          </RadixSelect.ScrollDownButton>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  )
}
