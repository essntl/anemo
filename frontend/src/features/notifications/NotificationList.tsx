import { type KeyboardEvent, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { AlarmClock, Bell, Bot, Check, CheckCheck, Clock, ShieldQuestion, SquareTerminal, Timer, Trash2, X } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { ActionMenu } from '@/components/ui/ActionMenu'
import { Button } from '@/components/ui/Button'
import { confirmDialog } from '@/components/ui/dialogs'
import { EmptyState } from '@/components/ui/EmptyState'
import { Markdown } from '@/components/ui/Markdown'
import { toast } from '@/components/ui/toast'
import { cn } from '@/lib/cn'
import { formatDateTime, formatWhen } from '@/lib/format'
import { t } from '@/lib/i18n'
import { type Notification, useClearNotifications, useDeleteNotification, useMarkRead, useNotifications } from './api'
import { byDay, CATEGORIES, type Category, categoryOf, countByCategory, DAY_LABELS } from './inbox'
import { InboxSection } from './InboxSection'

const ICONS: Record<Category | Notification['kind'], typeof Bell> = {
  job: SquareTerminal,
  reminder: AlarmClock,
  automation: Clock,
  approval: ShieldQuestion,
  agent: Bot,
  focus: Timer,
  system: Bell,
}
/** The level as a tint behind the icon and a thin bar at the row's edge. */
const LEVEL_TINT: Record<Notification['level'], string> = {
  info: 'bg-accent-soft text-accent',
  success: 'bg-success/12 text-success',
  warning: 'bg-warning/12 text-warning',
  error: 'bg-error/12 text-error',
}
/** Longer texts (an automation's whole answer) start folded. */
const LONG = 400

const fail = (err: unknown) => toast({ message: errorMessage(err) })

/** `first`: the row Tab reaches (the arrow keys go on from there). */
function NotificationRow({ note, first }: { note: Notification; first: boolean }) {
  const navigate = useNavigate()
  const markRead = useMarkRead()
  const remove = useDeleteNotification()
  const [expanded, setExpanded] = useState(false)
  const category = categoryOf(note)
  const Icon = category === 'job' ? ICONS.job : ICONS[note.kind] ?? Bell
  const unread = note.read_at === null
  const long = note.body.length > LONG

  const open = () => {
    if (unread) markRead.mutate([note.id])
    if (note.link) void navigate(note.link)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLLIElement>) => {
    if (e.target !== e.currentTarget || e.altKey || e.ctrlKey || e.metaKey) return
    if (e.key === 'Enter' || e.key === 'o') { e.preventDefault(); open() }
    else if (e.key === 'Delete' || e.key === 'Backspace' || e.key === 'x') { e.preventDefault(); remove.mutate(note.id, { onError: fail }) }
    else if (e.key === 'm' && unread) { e.preventDefault(); markRead.mutate([note.id]) }
  }

  return (
    <li data-note tabIndex={first ? 0 : -1} onKeyDown={onKeyDown} aria-label={note.title}
      className={cn('group relative flex gap-3 border-b border-border px-4 py-3 last:border-b-0 focus-visible:bg-surface-hover focus-visible:outline-none',
        unread && 'bg-accent-soft/35')}>
      {unread && <span aria-hidden className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent" />}
      <div aria-hidden className={cn('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', LEVEL_TINT[note.level])}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <button type="button" onClick={open} tabIndex={-1} className="min-w-0 flex-1 text-left">
            <span className={cn('break-words text-[13.5px]', unread ? 'font-semibold' : 'font-medium')}>{note.title}</span>
            {unread && <span className="ml-2 inline-block h-2 w-2 rounded-full bg-accent align-middle" aria-label={t('Unread')} />}
          </button>
          <time dateTime={note.created_at} title={formatDateTime(note.created_at)} className="shrink-0 pt-0.5 text-[12px] tabular-nums text-muted">{formatWhen(note.created_at)}</time>
        </div>
        {note.body && (
          <div className={cn('mt-0.5 text-muted [&_.markdown]:text-[13px] [&_.markdown]:leading-6', long && !expanded && 'max-h-28 overflow-hidden [mask-image:linear-gradient(black_60%,transparent)]')}>
            <Markdown text={note.body} />
          </div>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-1 gap-y-1 text-[12.5px]">
          {note.link && (
            <button type="button" onClick={open} className="rounded-control px-1.5 py-0.5 font-medium text-accent hover:bg-surface-hover">{t('Open')}</button>
          )}
          {unread && (
            <button type="button" onClick={() => markRead.mutate([note.id])} className="inline-flex items-center gap-1 rounded-control px-1.5 py-0.5 text-muted hover:bg-surface-hover hover:text-text">
              <Check aria-hidden className="h-3.5 w-3.5" />{t('Mark as read')}
            </button>
          )}
          {long && (
            <button type="button" className="rounded-control px-1.5 py-0.5 text-muted hover:bg-surface-hover hover:text-text" onClick={() => setExpanded(!expanded)}>
              {expanded ? t('Show less') : t('Show all')}
            </button>
          )}
        </div>
      </div>
      <button type="button" aria-label={t('Delete notification')} title={t('Delete notification')} onClick={() => remove.mutate(note.id, { onError: fail })}
        className="-mr-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-subtle hover:bg-surface-hover hover:text-text pointer-coarse:h-10 pointer-coarse:w-10">
        <X className="h-4 w-4" />
      </button>
    </li>
  )
}

/**
 * The notifications under Needs you and In progress: by day (Today, Yesterday, Earlier),
 * with chips to show one category, All or Unread, Mark all as read and Delete all.
 * Keyboard: ↑/↓ (or j/k) move between notifications, Enter opens, M marks as read,
 * Delete dismisses.
 */
export function NotificationList({ unread }: { unread: number }) {
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [category, setCategory] = useState<Category | null>(null)
  const notifications = useNotifications(unreadOnly)
  const markRead = useMarkRead()
  const clear = useClearNotifications()
  const list = useRef<HTMLDivElement>(null)
  const loaded = useMemo(() => notifications.data?.pages.flat() ?? [], [notifications.data])
  const counts = useMemo(() => countByCategory(loaded), [loaded])
  const shown = useMemo(() => (category ? loaded.filter((n) => categoryOf(n) === category) : loaded), [loaded, category])
  const days = useMemo(() => byDay(shown), [shown])

  const clearAll = async () => {
    const ok = await confirmDialog({
      title: t('Delete all notifications?'),
      message: t('This empties the list. What the notifications were about (tasks, runs, documents) is not affected.'),
      confirmLabel: t('Delete all'),
      danger: true,
    })
    if (ok) clear.mutate()
  }

  // ↑/↓ and j/k move between the notifications (and into the list from its chips).
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const down = e.key === 'ArrowDown' || e.key === 'j'
    const up = e.key === 'ArrowUp' || e.key === 'k'
    if (!down && !up) return
    const target = e.target as HTMLElement
    if (target.closest('input, textarea, [role="menu"]')) return
    const rows = [...(list.current?.querySelectorAll<HTMLElement>('[data-note]') ?? [])]
    if (rows.length === 0) return
    const at = rows.findIndex((r) => r.contains(target))
    const next = at < 0 ? (down ? 0 : rows.length - 1) : Math.min(Math.max(at + (down ? 1 : -1), 0), rows.length - 1)
    e.preventDefault()
    rows[next].focus()
  }

  const chip = (on: boolean) => cn('inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[12.5px] font-medium transition-colors pointer-coarse:h-9',
    on ? 'border-accent bg-accent-soft text-accent' : 'border-border text-muted hover:border-border-strong hover:text-text')

  return (
    <InboxSection id="notifications" title={t('Notifications')} count={unread} tone="accent"
      actions={<>
        <Button size="sm" variant="ghost" icon={<CheckCheck className="h-4 w-4" />} disabled={!unread}
          loading={markRead.isPending} onClick={() => markRead.mutate(undefined)}>
          {t('Mark all as read')}
        </Button>
        <ActionMenu actions={[{ label: t('Delete all'), icon: <Trash2 />, danger: true, onSelect: () => void clearAll() }]} />
      </>}>
      <div ref={list} onKeyDown={move}>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
          <div className="inline-flex rounded-lg bg-surface-2 p-0.5" role="tablist" aria-label={t('Which notifications')}>
            {[{ id: false, label: t('All') }, { id: true, label: unread ? t('Unread ({n})', { n: unread }) : t('Unread') }].map((tab) => (
              <button key={String(tab.id)} type="button" role="tab" aria-selected={unreadOnly === tab.id} onClick={() => setUnreadOnly(tab.id)}
                className={cn('flex h-7 items-center rounded-md px-2.5 text-[12.5px] font-medium transition-colors pointer-coarse:h-9',
                  unreadOnly === tab.id ? 'bg-surface text-text shadow-soft' : 'text-muted hover:text-text')}>
                {tab.label}
              </button>
            ))}
          </div>
          <div role="group" aria-label={t('Kind')} className="flex min-w-0 flex-1 flex-wrap gap-1.5">
            <button type="button" aria-pressed={category === null} onClick={() => setCategory(null)} className={chip(category === null)}>{t('Everything')}</button>
            {CATEGORIES.filter((c) => counts[c.id] > 0 || category === c.id).map((c) => {
              const Icon = ICONS[c.id]
              return (
                <button key={c.id} type="button" aria-pressed={category === c.id} onClick={() => setCategory(category === c.id ? null : c.id)} className={chip(category === c.id)}>
                  <Icon aria-hidden className="h-3.5 w-3.5" />{t(c.label)}
                  <span className="tabular-nums opacity-70">{counts[c.id]}</span>
                </button>
              )
            })}
          </div>
        </div>

        {notifications.isError && <p className="px-4 py-3 text-[13px] text-error">{errorMessage(notifications.error)}</p>}
        {notifications.isSuccess && shown.length === 0 && (
          <div className="p-4">
            <EmptyState compact icon={<Bell className="h-5 w-5" />}
              title={unreadOnly ? t('Nothing unread') : category ? t('Nothing of this kind') : t('No notifications yet')}
              description={unreadOnly ? t('You have seen everything.') : category ? t('Choose Everything to see the rest.') : t('Reminders for tasks and events, and what your automations report, show up here.')} />
          </div>
        )}
        {days.map(({ day, notes }) => (
          <div key={day}>
            <h3 className="flex items-center gap-2 bg-surface-2/60 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
              {t(DAY_LABELS[day])}
              <span className="rounded-full bg-surface-hover px-1.5 text-[10.5px] leading-4 tracking-normal tabular-nums">{notes.length}</span>
            </h3>
            <ul aria-label={t(DAY_LABELS[day])}>
              {notes.map((note) => <NotificationRow key={note.id} note={note} first={note.id === shown[0].id} />)}
            </ul>
          </div>
        ))}
        {notifications.hasNextPage && (
          <div className="flex justify-center border-t border-border p-3">
            <Button variant="secondary" size="sm" loading={notifications.isFetchingNextPage} onClick={() => void notifications.fetchNextPage()}>
              {t('Load more')}
            </Button>
          </div>
        )}
        {shown.length > 0 && (
          <p className="border-t border-border px-4 py-2 text-[11.5px] text-subtle max-md:hidden">
            {t('Keys: ↑ ↓ to move, Enter to open, M to mark as read, Delete to dismiss.')}
          </p>
        )}
      </div>
    </InboxSection>
  )
}
