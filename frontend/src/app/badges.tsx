import { useMemorySummary } from '@/features/memory/api'
import { useNotificationSummary } from '@/features/notifications/api'
import { useRunsSummary } from '@/features/runs/api'
import { cn } from '@/lib/cn'
import { plural, t } from '@/lib/i18n'

/** Agent runs that are working, or that wait for the user (approval or paused). */
export function RunsBadge() {
  const summary = useRunsSummary()
  const { active = 0, waiting = 0 } = summary.data ?? {}
  if (waiting) {
    return (
      <span title={t('{n} waiting for you', { n: waiting })}
        className="flex h-5 min-w-5 items-center justify-center rounded-full bg-warning px-1.5 text-[11px] font-semibold text-white">
        {waiting}
      </span>
    )
  }
  if (active) return <span title={t('{n} running', { n: active })} className="h-2 w-2 animate-pulse rounded-full bg-accent" />
  return null
}

/** Memory suggestions waiting for the user's decision. */
export function MemoryBadge() {
  const pending = useMemorySummary().data?.pending ?? 0
  if (!pending) return null
  return (
    <span title={plural(pending, '{n} suggestion to review', '{n} suggestions to review')}
      className="flex h-5 min-w-5 items-center justify-center rounded-full bg-warning px-1.5 text-[11px] font-semibold text-white">
      {pending}
    </span>
  )
}

/**
 * What waits in the Inbox, as one count: approvals and paused runs, and unread
 * notifications. Amber while something needs a decision. (Memory suggestions are not
 * counted here: they have their own count on Memory, under More.)
 */
export function InboxBadge() {
  const waiting = useRunsSummary().data?.waiting ?? 0
  const unread = useNotificationSummary().data?.unread ?? 0
  const total = waiting + unread
  if (!total) return null
  const decide = waiting
  return (
    <span title={[decide && plural(decide, '{n} needs you', '{n} need you'), unread && t('{n} unread', { n: unread })].filter(Boolean).join(', ')}
      className={cn('flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold', decide ? 'bg-warning text-white' : 'bg-accent text-accent-contrast')}>
      {total > 99 ? '99+' : total}
    </span>
  )
}
