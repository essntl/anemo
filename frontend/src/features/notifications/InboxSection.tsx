import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

const PILL = {
  warning: 'bg-warning text-white',
  accent: 'bg-accent text-accent-contrast',
  neutral: 'bg-surface-hover text-muted',
}

/**
 * One section of the Inbox: a card with a heading, a count and (on the right) the
 * section's own buttons. The count turns to the tone colour only while it is not zero.
 */
export function InboxSection({ id, title, count, tone = 'neutral', actions, children, className }: {
  id: string
  title: ReactNode
  count?: number
  tone?: keyof typeof PILL
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section aria-labelledby={`${id}-title`} className={cn('mb-5 rounded-card border border-border bg-card shadow-soft', className)}>
      <div className="flex min-h-11 flex-wrap items-center gap-2 border-b border-border px-4 py-1.5">
        <h2 id={`${id}-title`} className="flex min-w-0 flex-1 items-center gap-2 text-[13.5px] font-semibold">
          <span className="truncate">{title}</span>
          {count !== undefined && (
            <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums', count > 0 ? PILL[tone] : PILL.neutral)}>{count}</span>
          )}
        </h2>
        {actions && <div className="flex flex-wrap items-center gap-1">{actions}</div>}
      </div>
      {children}
    </section>
  )
}
