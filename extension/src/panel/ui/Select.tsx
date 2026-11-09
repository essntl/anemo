/**
 * A dropdown styled like the rest of the panel (the browser's own <select> list can't be
 * styled), as Anemo's own (frontend/src/components/ui/Select.tsx), with groups. Built on
 * Radix Select: keyboard, typeahead and screen readers work.
 */
import { Fragment, type ReactNode } from 'react'
import * as RadixSelect from '@radix-ui/react-select'
import { Check, ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '../lib/cn'

export interface SelectOption {
  value: string
  label: ReactNode
  /** Shown under the label in the list (not in the button). */
  hint?: ReactNode
  /** Options with the same group are listed together under its name. */
  group?: string
  disabled?: boolean
}

const VARIANTS = {
  field: 'h-9 w-full rounded-control border border-border bg-surface px-3 text-[13px] hover:border-border-strong data-[state=open]:border-accent focus:border-accent focus:ring-2 focus:ring-accent-soft',
  ghost: 'h-7 max-w-[11rem] rounded-md px-1.5 text-[12px] text-muted hover:bg-surface-hover hover:text-text data-[state=open]:bg-surface-hover data-[state=open]:text-text',
  pill: 'h-7 max-w-[11rem] gap-1 rounded-full bg-surface-2 pl-2.5 pr-1.5 text-[12px] hover:bg-surface-hover data-[state=open]:bg-surface-hover',
}

// Radix reserves "" for "nothing chosen"; "" is a handy "use the default" here.
const EMPTY = '__empty__'
const toRadix = (v: string) => (v === '' ? EMPTY : v)
const fromRadix = (v: string) => (v === EMPTY ? '' : v)

export function Select({
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  className,
  variant = 'field',
  side,
  icon,
  id,
  'aria-label': ariaLabel,
}: {
  value: string
  onValueChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  disabled?: boolean
  className?: string
  variant?: keyof typeof VARIANTS
  /** Where the list opens (the composer's pickers open upwards). */
  side?: 'top' | 'bottom'
  icon?: ReactNode
  /** For a <label htmlFor> (Field). */
  id?: string
  'aria-label'?: string
}) {
  const groups: { name: string | null; items: SelectOption[] }[] = []
  for (const o of options) {
    const name = o.group ?? null
    const last = groups.at(-1)
    if (last && last.name === name) last.items.push(o)
    else groups.push({ name, items: [o] })
  }
  return (
    <RadixSelect.Root value={toRadix(value)} onValueChange={(v) => onValueChange(fromRadix(v))} disabled={disabled}>
      <RadixSelect.Trigger
        id={id}
        aria-label={ariaLabel}
        className={cn('group inline-flex min-w-0 items-center justify-between gap-1.5 text-left focus:outline-none disabled:opacity-60 data-[placeholder]:text-subtle', VARIANTS[variant], className)}
      >
        {icon}
        <span className={cn('min-w-0 truncate', variant === 'field' && 'w-0 flex-1')}>
          {/* The chosen option's label, given explicitly: options that arrive after the
              first render (loaded from Anemo) would otherwise show nothing until opened. */}
          <RadixSelect.Value placeholder={placeholder}>{options.find((o) => o.value === value)?.label}</RadixSelect.Value>
        </span>
        <RadixSelect.Icon>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60 transition-transform group-data-[state=open]:rotate-180" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          side={side}
          sideOffset={6}
          collisionPadding={10}
          className={cn(
            'pop z-50 min-w-[max(var(--radix-select-trigger-width),12rem)] max-w-[min(24rem,calc(100vw-20px))]',
            'max-h-[min(22rem,var(--radix-select-content-available-height))] overflow-hidden rounded-card border border-border bg-card shadow-float',
          )}
        >
          <RadixSelect.ScrollUpButton className="flex h-6 items-center justify-center text-muted">
            <ChevronUp className="h-4 w-4" />
          </RadixSelect.ScrollUpButton>
          <RadixSelect.Viewport className="p-1.5">
            {groups.map((g, i) => (
              <Fragment key={`${g.name ?? ''}${i}`}>
                {i > 0 && <RadixSelect.Separator className="mx-2 my-1 h-px bg-border" />}
                <RadixSelect.Group>
                  {g.name && <RadixSelect.Label className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-subtle">{g.name}</RadixSelect.Label>}
                  {g.items.map((o) => (
                    <RadixSelect.Item
                      key={o.value}
                      value={toRadix(o.value)}
                      disabled={o.disabled}
                      className={cn(
                        'relative flex cursor-pointer select-none flex-col rounded-control py-1.5 pl-8 pr-3 text-[13px] outline-none',
                        'data-[highlighted]:bg-surface-hover data-[state=checked]:font-medium data-[state=checked]:text-accent',
                        'data-[disabled]:cursor-default data-[disabled]:opacity-50',
                      )}
                    >
                      <RadixSelect.ItemIndicator className="absolute left-2.5 top-2 inline-flex">
                        <Check className="h-4 w-4" />
                      </RadixSelect.ItemIndicator>
                      <RadixSelect.ItemText>{o.label}</RadixSelect.ItemText>
                      {o.hint && <span className="text-[11.5px] font-normal text-muted">{o.hint}</span>}
                    </RadixSelect.Item>
                  ))}
                </RadixSelect.Group>
              </Fragment>
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
