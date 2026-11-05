import { Fragment } from 'react'
import { cn } from '@/lib/cn'
import { isApple, SHORTCUTS, shownCombos, type ShortcutId } from './registry'

export function Kbd({ children, className }: { children: string; className?: string }) {
  return (
    <kbd className={cn('inline-flex min-w-[1.6em] items-center justify-center rounded-md border border-border bg-surface-2 px-1.5 py-0.5 font-sans text-[11px] leading-none text-muted', className)}>
      {children}
    </kbd>
  )
}

/** The keys of a shortcut from the registry, as key caps: Ctrl K, or ⌘ K on a Mac. */
export function ShortcutKeys({ id, className }: { id: ShortcutId; className?: string }) {
  const apple = isApple()
  const combos = shownCombos(SHORTCUTS[id], apple)
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1', className)}>
      {combos.map((combo, i) => (
        <Fragment key={combo.join('+')}>
          {i > 0 && <span className="text-[11px] text-subtle">/</span>}
          {combo.map((part) => <Kbd key={part}>{part}</Kbd>)}
        </Fragment>
      ))}
    </span>
  )
}
