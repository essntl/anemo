import { useMemorySummary } from '@/features/memory/api'
import { useNotificationSummary } from '@/features/notifications/api'
import { useRunsSummary } from '@/features/runs/api'
import { cn } from '@/lib/cn'

/** Agent runs that are working, or that wait for the user (approval or paused). */
export function RunsBadge() {
  const summary = useRunsSummary()
  const { active = 0, waiting = 0 } = summary.data ?? {}
  if (waiting) {
    return (
      <span title={`${waiting} waiting for you`}
        className="flex h-5 min-w-5 items-center justify-center rounded-full bg-warning px-1.5 text-[11px] font-semibold text-white">
        {waiting}
      </span>
    )
  }
  if (active) return <span title={`${active} running`} className="h-2 w-2 animate-pulse rounded-full bg-accent" />
  return null
}

/** Memory suggestions waiting for the user's decision. */
export function MemoryBadge() {
  const pending = useMemorySummary().data?.pending ?? 0
  if (!pending) return null
  return (
    <span title={`${pending} suggestion${pending === 1 ? '' : 's'} to review`}
      className="flex h-5 min-w-5 items-center justify-center rounded-full bg-warning px-1.5 text-[11px] font-semibold text-white">
      {pending}
    </span>
  )
}

/**
 * Everything that waits in the Inbox, as one count: approvals and paused runs, memory
 * suggestions and unread notifications. Amber while something needs a decision.
 */
export function InboxBadge() {
  const waiting = useRunsSummary().data?.waiting ?? 0
  const pending = useMemorySummary().data?.pending ?? 0
  const unread = useNotificationSummary().data?.unread ?? 0
  const total = waiting + pending + unread
  if (!total) return null
  const decide = waiting + pending
  return (
    <span title={[decide && `${decide} need${decide === 1 ? 's' : ''} you`, unread && `${unread} unread`].filter(Boolean).join(', ')}
      className={cn('flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold', decide ? 'bg-warning text-white' : 'bg-accent text-accent-contrast')}>
      {total > 99 ? '99+' : total}
    </span>
  )
}
