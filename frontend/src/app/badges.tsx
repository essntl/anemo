import { useMemorySummary } from '@/features/memory/api'
import { useInboxCount } from '@/features/notifications/useInboxCount'
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
 * The Inbox's badge: amber with the number of things that wait for a decision
 * (approvals, questions, reviews, failed automations) while there are any; otherwise the
 * accent colour with the number of unread notifications. The tooltip names both.
 */
export function InboxBadge() {
  const { decisions, unread } = useInboxCount()
  if (!decisions && !unread) return null
  const shown = decisions || unread
  return (
    <span title={[decisions && plural(decisions, '{n} needs you', '{n} need you'), unread && t('{n} unread', { n: unread })].filter(Boolean).join(', ')}
      className={cn('flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold', decisions ? 'bg-warning text-white' : 'bg-accent text-accent-contrast')}>
      {shown > 99 ? '99+' : shown}
    </span>
  )
}
