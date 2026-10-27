import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { cn } from '@/lib/cn'
import { spring } from '@/lib/motion'

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  /** Accessible name when the label is only an icon or has extra bits (counts). */
  ariaLabel?: string
}

interface SegmentedProps<T extends string> {
  value: T
  onChange: (value: T) => void
  options: SegmentedOption<T>[]
  /** Accessible name of the group, e.g. "Timer phase". */
  label: string
  /**
   * `radio` (default) picks a value; `tabs` switches what is shown below it (pass the
   * panel's id with `controls`).
   */
  kind?: 'radio' | 'tabs'
  /** With kind="tabs": id prefix of the panels, `${controls}-${value}`. */
  controls?: string
  size?: 'sm' | 'md'
  className?: string
}

/**
 * A row of mutually exclusive options with a sliding highlight. One stop in the tab
 * order: arrow keys (and Home/End) move between the options and select them.
 *
 *   <Segmented label="Timer phase" value={phase} onChange={setPhase}
 *     options={[{ value: 'focus', label: 'Focus' }, { value: 'short_break', label: 'Short break' }]} />
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  kind = 'radio',
  controls,
  size = 'md',
  className,
}: SegmentedProps<T>) {
  const id = useId()
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const current = Math.max(0, options.findIndex((o) => o.value === value))

  function onKeyDown(e: KeyboardEvent) {
    const last = options.length - 1
    const to: Record<string, number> = {
      ArrowRight: current === last ? 0 : current + 1,
      ArrowDown: current === last ? 0 : current + 1,
      ArrowLeft: current === 0 ? last : current - 1,
      ArrowUp: current === 0 ? last : current - 1,
      Home: 0,
      End: last,
    }
    if (!(e.key in to)) return
    e.preventDefault()
    const next = to[e.key]
    onChange(options[next].value)
    refs.current[next]?.focus()
  }

  const tabs = kind === 'tabs'
  return (
    <div
      role={tabs ? 'tablist' : 'radiogroup'}
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn('inline-flex max-w-full rounded-control bg-surface-2 p-1', className)}
    >
      {options.map((o, i) => {
        const active = i === current
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role={tabs ? 'tab' : 'radio'}
            aria-selected={tabs ? active : undefined}
            aria-checked={tabs ? undefined : active}
            aria-controls={tabs && controls ? `${controls}-${o.value}` : undefined}
            aria-label={o.ariaLabel}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={cn(
              'relative flex min-w-0 flex-auto items-center justify-center gap-1.5 whitespace-nowrap rounded-[8px] font-medium transition-colors [&_svg]:h-4 [&_svg]:w-4',
              size === 'sm' ? 'h-7 px-2.5 text-[12px] pointer-coarse:h-9' : 'h-8 px-3.5 text-[13px] pointer-coarse:h-10',
              active ? 'text-text' : 'text-muted hover:text-text',
            )}
          >
            {active && (
              <motion.span
                layoutId={`segmented-${id}`}
                transition={spring.snappy}
                className="absolute inset-0 rounded-[8px] bg-card shadow-soft"
              />
            )}
            <span className="relative flex min-w-0 items-center gap-1.5 truncate">{o.label}</span>
          </button>
        )
      })}
    </div>
  )
}
