import { useId, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Switch } from './Switch'

/**
 * One setting in a card: its name and a short description on the left, its control on
 * the right, centred against the text (not against the first line). What the setting
 * reveals when it is on (the colour picker under "Background tint") goes in `children`:
 * it is shown in the same card, under a divider, and folds open and shut smoothly.
 *
 *   <Card>
 *     <SettingRow heading title="Frosted glass" description="…" checked={on} onCheckedChange={setOn}>
 *       <Slider … />
 *     </SettingRow>
 *   </Card>
 *
 * With `checked`/`onCheckedChange` the row draws its switch itself, and clicking the
 * title flips it too. Any other control (a Select, a button) goes in `control`.
 * `heading`: the row is the card's title (bigger text and the card's own padding);
 * otherwise rows sit in a <SettingRows> list, separated by lines.
 * The padding comes from the density tokens (--card-x, --card-y, --row-y in tokens.css).
 */
export function SettingRow({
  title,
  description,
  control,
  checked,
  onCheckedChange,
  disabled,
  heading = false,
  open,
  children,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  control?: ReactNode
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
  disabled?: boolean
  heading?: boolean
  /** Whether `children` is shown (default: when the switch is on, or always without one). */
  open?: boolean
  children?: ReactNode
  className?: string
}) {
  const id = useId()
  const hasSwitch = checked !== undefined && onCheckedChange !== undefined
  const Title = heading ? 'h3' : 'div'
  const label = typeof title === 'string' ? title : undefined
  const shown = open ?? (hasSwitch ? checked : true)
  return (
    <div className={cn('px-(--card-x)', heading ? 'py-(--card-y)' : 'py-(--row-y)', className)}>
      {/* A wide control (a segmented choice) moves under the text when the row is narrow. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-52">
          <Title className={heading ? 'text-[15px] font-semibold' : 'text-[13.5px] font-medium'}>
            {/* A label, so clicking the name flips the switch as clicking the switch does. */}
            {hasSwitch ? <label htmlFor={id} className={cn(!disabled && 'cursor-pointer')}>{title}</label> : title}
          </Title>
          {description && (
            <div className={cn('mt-0.5 max-w-prose text-muted', heading ? 'text-[13px]' : 'text-[12.5px]')}>{description}</div>
          )}
        </div>
        {(hasSwitch || control) && (
          // On a phone a wide control (a choice, a select) takes its own full-width line.
          <div className={cn('flex shrink-0 items-center', !hasSwitch && 'max-sm:basis-full max-sm:[&>*]:flex-1')}>
            {hasSwitch ? <Switch id={id} label={label ?? ''} checked={checked} disabled={disabled} onChange={onCheckedChange} /> : control}
          </div>
        )}
      </div>
      {children !== undefined && <Reveal open={shown}>{children}</Reveal>}
    </div>
  )
}

/**
 * Content that folds open below a row, after a divider that spans the card. It stays in
 * the page while closed (so it can animate shut) but can't be focused or read then.
 */
export function Reveal({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div
      inert={!open}
      aria-hidden={!open || undefined}
      data-open={open}
      // The negative margin is out here, not inside the clipping box, so the divider
      // reaches both edges of the card.
      className={cn(
        '-mx-(--card-x) grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none',
        open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
      )}
    >
      <div className="min-h-0 overflow-hidden">
        <div className="mt-(--card-y) border-t border-border px-(--card-x) pt-(--card-y)">{children}</div>
      </div>
    </div>
  )
}

/** Several setting rows in one card, separated by lines. */
export function SettingRows({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-col divide-y divide-border py-[calc(var(--row-y)/2)]', className)}>{children}</div>
}

/**
 * A labelled control inside a setting's card: the label in a fixed column on the left,
 * so the controls of one card line up (the same column as SliderField's label); on a
 * phone the label goes above the control.
 */
export function FieldRow({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    // Phones: the label above the control, so the control gets the whole width.
    <div className={cn('grid grid-cols-1 gap-1.5 sm:grid-cols-[5.5rem_minmax(0,1fr)] sm:items-center sm:gap-3 md:grid-cols-[7rem_minmax(0,1fr)]', className)}>
      <span className="text-[13px] text-muted">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}
