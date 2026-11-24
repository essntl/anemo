/**
 * The look of a box a message is typed into (the chat's message box, the follow-up box
 * under a Claude Code thread): the frame, the text and the round button that sends it.
 * What each box does with the message stays with the box.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { ArrowUp } from 'lucide-react'
import { cn } from '@/lib/cn'

/** The frame around the text and its buttons. Add the border's colour (`MESSAGE_BOX_BORDER` at rest). */
export const MESSAGE_BOX = 'glass relative rounded-panel border bg-card p-2 shadow-soft transition-colors focus-within:border-accent/60'
export const MESSAGE_BOX_BORDER = 'border-border-strong'

/** The text itself: a `<textarea rows={1}>` that grows with what is typed (the box sets its height). */
export const MESSAGE_TEXT = 'block max-h-60 min-w-0 flex-1 resize-none bg-transparent px-3 py-2 text-[14.5px] placeholder:text-subtle focus:outline-none'

const ROUND = 'flex h-9 w-9 shrink-0 items-center justify-center rounded-full pointer-coarse:h-10 pointer-coarse:w-10'

interface SendButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> {
  /** What the button does, for screen readers: it shows only an icon. */
  label: string
  /** Instead of the arrow up. */
  icon?: ReactNode
  /** Not the main thing to do here (it queues rather than sends): grey, not the accent colour. */
  quiet?: boolean
}

/** The round button at the right end of a message box. */
export function SendButton({ label, icon, quiet, className, type = 'button', ...rest }: SendButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      className={cn(
        ROUND, 'transition-all disabled:cursor-not-allowed disabled:opacity-40',
        quiet ? 'bg-surface-2 text-text hover:bg-surface-hover' : 'bg-accent text-accent-contrast hover:bg-accent-hover',
        className,
      )}
      {...rest}
    >
      {icon ?? <ArrowUp className="h-4 w-4" />}
    </button>
  )
}
