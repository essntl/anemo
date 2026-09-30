import * as RadixDialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  /** Extra classes; use `md:` for sizes so the phone bottom sheet stays full width. */
  className?: string
}

/**
 * On phones (below `md`) a dialog is a bottom sheet: full width, anchored to the
 * bottom edge where thumbs reach, scrollable if tall. From `md` up it is centered.
 */
export function Dialog({ open, onOpenChange, title, description, children, footer, className }: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fade fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px]" />
        <RadixDialog.Content
          className={cn(
            'sheet fixed inset-x-0 bottom-0 z-50 max-h-[90dvh] overflow-y-auto rounded-t-panel border border-border bg-card p-5 shadow-float focus:outline-none',
            'pb-[max(1.25rem,env(safe-area-inset-bottom))]',
            'md:inset-x-auto md:bottom-auto md:left-1/2 md:top-1/2 md:w-[min(92vw,440px)] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-panel md:p-6',
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <RadixDialog.Title className="text-base font-semibold">{title}</RadixDialog.Title>
              {description && (
                <RadixDialog.Description className="mt-1 text-[13px] text-muted">
                  {description}
                </RadixDialog.Description>
              )}
            </div>
            <RadixDialog.Close className="rounded-lg p-1 text-muted hover:bg-surface-hover hover:text-text pointer-coarse:p-2.5">
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </RadixDialog.Close>
          </div>
          <div className="mt-5">{children}</div>
          {footer && <div className="mt-6 flex flex-wrap justify-end gap-2">{footer}</div>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}
