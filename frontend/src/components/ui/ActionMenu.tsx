import { useCallback, useState, type ReactNode } from 'react'
import * as Popover from '@radix-ui/react-popover'
import * as RadixDialog from '@radix-ui/react-dialog'
import { MoreHorizontal } from 'lucide-react'
import { useCloseOnScroll } from '@/hooks/useCloseOnScroll'
import { DESKTOP, useMediaQuery } from '@/hooks/useMediaQuery'
import { cn } from '@/lib/cn'

export interface MenuAction {
  label: string
  icon: ReactNode
  onSelect?: () => void
  /** Renders a download link instead of a button. */
  download?: string
  /** Renders a link that opens in a new tab (e.g. a track on YouTube). */
  href?: string
  danger?: boolean
}

/**
 * A "⋯" button with a list of actions. Used where desktop shows actions on hover,
 * which touch screens can't do.
 *
 * From `md` up the list pops up next to the button (and scrolls if the window is too
 * low for it). On phones it is a sheet along the bottom edge instead, like the dialogs:
 * a popup next to a button low in a list had no room and ran off the screen.
 */
export function ActionMenu({ actions, label = 'More actions', className }: { actions: MenuAction[]; label?: string; className?: string }) {
  const [open, setOpen] = useState(false)
  const desktop = useMediaQuery(DESKTOP)
  useCloseOnScroll(open && desktop, useCallback(() => setOpen(false), []))
  const trigger = (
    <button type="button" aria-label={label}
      className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface-hover hover:text-text', className)}>
      <MoreHorizontal className="h-4.5 w-4.5" />
    </button>
  )
  const list = <ActionList actions={actions} large={!desktop} onDone={() => setOpen(false)} />

  if (!desktop) {
    return (
      <RadixDialog.Root open={open} onOpenChange={setOpen}>
        <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger>
        <RadixDialog.Portal>
          <RadixDialog.Overlay className="fade fixed inset-0 z-50 bg-black/30" />
          <RadixDialog.Content aria-describedby={undefined}
            className="sheet fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col rounded-t-panel border border-border bg-card px-2 pt-2 shadow-float focus:outline-none pb-[max(0.5rem,env(safe-area-inset-bottom))]">
            <RadixDialog.Title className="sr-only">{label}</RadixDialog.Title>
            <div className="min-h-0 overflow-y-auto">{list}</div>
          </RadixDialog.Content>
        </RadixDialog.Portal>
      </RadixDialog.Root>
    )
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={4} collisionPadding={12}
          className="pop z-50 max-h-[var(--radix-popover-content-available-height)] min-w-48 overflow-y-auto rounded-card border border-border bg-card p-1.5 shadow-float">
          {list}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function ActionList({ actions, large, onDone }: { actions: MenuAction[]; large: boolean; onDone: () => void }) {
  const item = (danger?: boolean) =>
    cn('flex w-full items-center gap-3 rounded-control px-3 text-left hover:bg-surface-hover [&>svg]:h-4 [&>svg]:w-4',
      large ? 'h-12 text-[16px] [&>svg]:h-5 [&>svg]:w-5' : 'h-11 text-[15px]',
      danger ? 'text-error' : 'text-text')
  return actions.map((a) =>
    a.download ? (
      <a key={a.label} href={a.download} download className={item(a.danger)} onClick={onDone}>
        {a.icon} {a.label}
      </a>
    ) : a.href ? (
      <a key={a.label} href={a.href} target="_blank" rel="noreferrer noopener" className={item(a.danger)} onClick={onDone}>
        {a.icon} {a.label}
      </a>
    ) : (
      <button key={a.label} type="button" className={item(a.danger)}
        onClick={() => { onDone(); a.onSelect?.() }}>
        {a.icon} {a.label}
      </button>
    ),
  )
}
