/**
 * Notifications: reminders, results of automations, approval requests and
 * messages from agents, newest first. Opening one marks it as read.
 */
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { AlarmClock, Bell, Bot, CheckCheck, Clock, ShieldQuestion, Trash2, X } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { ActionMenu } from '@/components/ui/ActionMenu'
import { Button } from '@/components/ui/Button'
import { confirmDialog } from '@/components/ui/dialogs'
import { EmptyState } from '@/components/ui/EmptyState'
import { Markdown } from '@/components/ui/Markdown'
import { cn } from '@/lib/cn'
import { formatWhen } from '@/lib/format'
import {
  type Notification,
  type NotificationKind,
  useClearNotifications,
  useDeleteNotification,
  useMarkRead,
  useNotifications,
  useNotificationSummary,
} from './api'

const ICONS: Record<NotificationKind, typeof Bell> = {
  reminder: AlarmClock,
  automation: Clock,
  approval: ShieldQuestion,
  agent: Bot,
}
const LEVEL_COLORS: Record<Notification['level'], string> = {
  info: 'bg-accent-soft text-accent',
  success: 'bg-success/12 text-success',
  warning: 'bg-warning/12 text-warning',
  error: 'bg-error/12 text-error',
}
/** Longer texts (an automation's whole answer) start folded. */
const LONG = 400

function NotificationRow({ note }: { note: Notification }) {
  const navigate = useNavigate()
  const markRead = useMarkRead()
  const remove = useDeleteNotification()
  const [expanded, setExpanded] = useState(false)
  const Icon = ICONS[note.kind]
  const unread = note.read_at === null
  const long = note.body.length > LONG

  const open = () => {
    if (unread) markRead.mutate([note.id])
    if (note.link) void navigate(note.link)
  }

  return (
    <div className={cn('flex gap-3 rounded-card border bg-card px-4 py-3 shadow-soft', unread ? 'border-accent/40' : 'border-border')}>
      <div className={cn('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', LEVEL_COLORS[note.level])}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <button type="button" onClick={open} className="min-w-0 flex-1 text-left">
            <span className={cn('break-words text-[14px]', unread ? 'font-semibold' : 'font-medium')}>{note.title}</span>
            {unread && <span className="ml-2 inline-block h-2 w-2 rounded-full bg-accent align-middle" aria-label="Unread" />}
          </button>
          <span className="shrink-0 pt-0.5 text-[12px] text-muted">{formatWhen(note.created_at)}</span>
        </div>
        {note.body && (
          <div className={cn('mt-1 text-muted [&_.markdown]:text-[13px] [&_.markdown]:leading-6', long && !expanded && 'max-h-28 overflow-hidden [mask-image:linear-gradient(black_60%,transparent)]')}>
            <Markdown text={note.body} />
          </div>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
          {long && (
            <button type="button" className="text-accent hover:underline" onClick={() => setExpanded(!expanded)}>
              {expanded ? 'Show less' : 'Show all'}
            </button>
          )}
          {note.link && <button type="button" className="text-accent hover:underline" onClick={open}>Open</button>}
          {unread && !note.link && (
            <button type="button" className="text-accent hover:underline" onClick={() => markRead.mutate([note.id])}>
              Mark as read
            </button>
          )}
        </div>
      </div>
      <button type="button" aria-label="Delete notification" onClick={() => remove.mutate(note.id)}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-subtle hover:bg-surface-hover hover:text-text pointer-coarse:h-10 pointer-coarse:w-10">
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}

export function NotificationsPage() {
  const [unreadOnly, setUnreadOnly] = useState(false)
  const notifications = useNotifications(unreadOnly)
  const summary = useNotificationSummary()
  const markRead = useMarkRead()
  const clear = useClearNotifications()
  const items = notifications.data?.pages.flat() ?? []
  const unread = summary.data?.unread ?? 0

  const clearAll = async () => {
    const ok = await confirmDialog({
      title: 'Delete all notifications?',
      message: 'This empties the list. What the notifications were about (tasks, runs, documents) is not affected.',
      confirmLabel: 'Delete all',
      danger: true,
    })
    if (ok) clear.mutate()
  }

  return (
    <div className="mx-auto max-w-3xl p-4 md:p-8">
      <div className="mb-5 flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Bell className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold">Notifications</h1>
          <p className="text-[13px] text-muted">
            Reminders, automation results and messages from agents.{' '}
            <Link to="/settings/notifications" className="text-accent underline">Settings</Link>
          </p>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-lg bg-surface-2 p-0.5" role="tablist" aria-label="Which notifications">
          {[{ id: false, label: 'All' }, { id: true, label: unread ? `Unread (${unread})` : 'Unread' }].map((t) => (
            <button key={t.label} type="button" role="tab" aria-selected={unreadOnly === t.id} onClick={() => setUnreadOnly(t.id)}
              className={cn('flex h-8 items-center rounded-md px-3 text-[13px] font-medium transition-colors pointer-coarse:h-10',
                unreadOnly === t.id ? 'bg-surface text-text shadow-soft' : 'text-muted hover:text-text')}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="secondary" icon={<CheckCheck className="h-4 w-4" />} disabled={!unread}
            loading={markRead.isPending} onClick={() => markRead.mutate(undefined)}>
            Mark all as read
          </Button>
          <ActionMenu actions={[{ label: 'Delete all', icon: <Trash2 />, danger: true, onSelect: () => void clearAll() }]} />
        </div>
      </div>

      {notifications.isError && <p className="text-[13px] text-error">{errorMessage(notifications.error)}</p>}
      {notifications.isSuccess && items.length === 0 && (
        <EmptyState icon={<Bell className="h-5 w-5" />}
          title={unreadOnly ? 'Nothing unread' : 'No notifications yet'}
          description={unreadOnly ? 'You have seen everything.' : 'Reminders for tasks and events, and what your automations report, show up here.'} />
      )}
      <div className="flex flex-col gap-2">
        {items.map((note) => <NotificationRow key={note.id} note={note} />)}
      </div>
      {notifications.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button variant="secondary" loading={notifications.isFetchingNextPage} onClick={() => void notifications.fetchNextPage()}>
            Load more
          </Button>
        </div>
      )}
    </div>
  )
}
