/**
 * The Inbox, as an overview: first what needs the user (approvals, questions, reviews,
 * failed automations, overdue tasks), each with its main action in place; then what is
 * going on (Claude Code jobs, chats waiting for an event, running automations); then the
 * notifications by day. The line under the title counts each part and jumps to it.
 */
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { PageHeader } from '@/components/ui/PageHeader'
import { useNeedsYou } from '@/features/home/useNeedsYou'
import { cn } from '@/lib/cn'
import { plural, rich, t } from '@/lib/i18n'
import { useNotificationSummary } from './api'
import { InProgressSection } from './InProgressSection'
import { NeedsYouSection } from './NeedsYouSection'
import { NotificationList } from './NotificationList'
import { useInProgress } from './useInProgress'

function Jump({ to, n, tone, children }: { to: string; n: number; tone: string; children: ReactNode }) {
  return (
    <a href={`#${to}`} onClick={(e) => { e.preventDefault(); document.getElementById(`${to}-title`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }}
      className={cn('inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12.5px] font-medium transition-colors hover:bg-surface-hover pointer-coarse:h-9',
        n > 0 ? 'border-border-strong text-text' : 'border-border text-muted')}>
      <span aria-hidden className={cn('h-2 w-2 rounded-full', n > 0 ? tone : 'bg-border-strong')} />
      {children}
    </a>
  )
}

export function NotificationsPage() {
  // Memory suggestions are handled on the Memory page (and counted there), not in the Inbox.
  const needs = useNeedsYou().rows.filter((r) => r.kind !== 'memory')
  const progress = useInProgress()
  const unread = useNotificationSummary().data?.unread ?? 0

  return (
    <div className="mx-auto max-w-3xl p-4 md:px-8 md:pb-8 md:pt-2">
      <PageHeader title={t('Inbox')} />
      <p className="mb-3 max-w-2xl text-[13px] text-muted">
        {rich('What waits for you, what is running, then reminders, automation results and messages from agents. <a>Settings</a>', { a: (c) => <Link to="/settings/notifications" className="text-accent underline">{c}</Link> })}
      </p>
      <nav aria-label={t('Inbox overview')} className="mb-4 flex flex-wrap gap-1.5">
        <Jump to="needs-you" n={needs.length} tone="bg-warning">{plural(needs.length, '{n} needs you', '{n} need you')}</Jump>
        <Jump to="in-progress" n={progress.items.length} tone="bg-accent">{t('{n} in progress', { n: progress.items.length })}</Jump>
        <Jump to="notifications" n={unread} tone="bg-accent">{t('{n} unread', { n: unread })}</Jump>
      </nav>

      <NeedsYouSection rows={needs} />
      <InProgressSection items={progress.items} />
      <NotificationList unread={unread} />
    </div>
  )
}
