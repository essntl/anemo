/** A "⋯" button with a list of actions (as Anemo's ActionMenu), on Radix Popover. */
import { useState, type ReactNode } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { MoreHorizontal } from 'lucide-react'
import { cn } from '../lib/cn'

export interface MenuAction {
  label: string
  icon: ReactNode
  onSelect: () => void
  danger?: boolean
  /** A line above this action. */
  separated?: boolean
}

export function ActionMenu({ actions, label = 'More actions', className, trigger }: { actions: MenuAction[]; label?: string; className?: string; trigger?: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        {trigger ?? (
          <button
            type="button"
            aria-label={label}
            title={label}
            className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface-hover hover:text-text data-[state=open]:bg-surface-hover data-[state=open]:text-text', className)}
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={4}
          collisionPadding={10}
          role="menu"
          aria-label={label}
          className="pop z-50 max-h-[var(--radix-popover-content-available-height)] min-w-44 overflow-y-auto rounded-card border border-border bg-card p-1.5 shadow-float"
        >
          {actions.map((a) => (
            <div key={a.label}>
              {a.separated && <div className="mx-2 my-1 h-px bg-border" />}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false)
                  a.onSelect()
                }}
                className={cn('flex h-9 w-full items-center gap-2.5 rounded-control px-2.5 text-left text-[13px] hover:bg-surface-hover focus:bg-surface-hover focus:outline-none [&>svg]:h-4 [&>svg]:w-4 [&>svg]:shrink-0', a.danger ? 'text-error' : 'text-text')}
              >
                {a.icon}
                {a.label}
              </button>
            </div>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
