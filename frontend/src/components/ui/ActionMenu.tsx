import { useCallback, useState, type ReactNode } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { MoreHorizontal } from 'lucide-react'
import { useCloseOnScroll } from '@/hooks/useCloseOnScroll'
import { cn } from '@/lib/cn'

export interface MenuAction {
  label: string
  icon: ReactNode
  onSelect?: () => void
  /** Renders a download link instead of a button. */
  download?: string
  danger?: boolean
}

/**
 * A "⋯" button with a list of actions. Used where desktop shows actions on hover,
 * which touch screens can't do.
 */
export function ActionMenu({ actions, label = 'More actions', className }: { actions: MenuAction[]; label?: string; className?: string }) {
  const [open, setOpen] = useState(false)
  useCloseOnScroll(open, useCallback(() => setOpen(false), []))
  const item = (danger?: boolean) =>
    cn('flex h-11 w-full items-center gap-3 rounded-control px-3 text-left text-[15px] hover:bg-surface-hover [&>svg]:h-4 [&>svg]:w-4',
      danger ? 'text-error' : 'text-text')
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" aria-label={label}
          className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface-hover hover:text-text', className)}>
          <MoreHorizontal className="h-4.5 w-4.5" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={4} collisionPadding={12}
          className="z-50 min-w-48 rounded-card border border-border bg-card p-1.5 shadow-float">
          {actions.map((a) =>
            a.download ? (
              <a key={a.label} href={a.download} download className={item(a.danger)} onClick={() => setOpen(false)}>
                {a.icon} {a.label}
              </a>
            ) : (
              <button key={a.label} type="button" className={item(a.danger)}
                onClick={() => { setOpen(false); a.onSelect?.() }}>
                {a.icon} {a.label}
              </button>
            ),
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
