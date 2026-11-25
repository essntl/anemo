import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * What a list shows while it has nothing in it. `compact`: a smaller block inside a
 * dashed frame, for a page where it sits under a header and tabs (Automations); extra
 * content (templates to start from) goes in `children`, under the action.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  compact = false,
  children,
}: {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
  compact?: boolean
  children?: ReactNode
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center',
      compact ? 'rounded-card border border-dashed border-border-strong px-5 py-8' : 'px-6 py-16')}>
      {icon && (
        <div className={cn('flex items-center justify-center rounded-2xl bg-accent-soft text-accent', compact ? 'mb-3 h-10 w-10' : 'mb-4 h-12 w-12')}>
          {icon}
        </div>
      )}
      <h3 className="text-base font-semibold">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-[13px] text-muted">{description}</p>}
      {action && <div className={compact ? 'mt-4' : 'mt-5'}>{action}</div>}
      {children}
    </div>
  )
}
