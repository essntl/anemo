import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { AlarmClockCheck, Clock, SquareTerminal } from 'lucide-react'
import { Elapsed } from '@/components/ui/Elapsed'
import { cn } from '@/lib/cn'
import { formatAge, formatDateTime } from '@/lib/format'
import { msg, t } from '@/lib/i18n'
import { InboxSection } from './InboxSection'
import type { InProgressItem } from './useInProgress'

const ICON: Record<InProgressItem['kind'], ReactNode> = {
  job: <SquareTerminal />,
  wake: <AlarmClockCheck />,
  automation: <Clock />,
}
const KIND_LABEL: Record<InProgressItem['kind'], string> = {
  job: msg('Claude Code job'),
  wake: msg('Waits for an event'),
  automation: msg('Automation'),
}

/**
 * Running / in progress: Claude Code jobs, chats waiting to be woken by an event, and
 * automations running now. A strip of compact cards (one column on phones); each opens
 * the job, the chat or the run. Jobs and runs count up how long they have been going.
 */
export function InProgressSection({ items }: { items: InProgressItem[] }) {
  return (
    <InboxSection id="in-progress" title={t('In progress')} count={items.length} tone="accent"
      actions={items.some((i) => i.kind === 'job') ? <Link to="/code" className="rounded-control px-2 py-1 text-[12.5px] font-medium text-accent hover:bg-surface-hover">{t('All jobs')}</Link> : undefined}>
      {items.length === 0 ? (
        <p className="px-4 py-3 text-[13px] text-muted">{t('Nothing is running. Claude Code jobs, automations and chats waiting for an event show up here.')}</p>
      ) : (
        <ul className="grid gap-2 p-3 sm:grid-cols-2">
          {items.map((item) => (
            <li key={item.key}>
              <Link to={item.to}
                className="flex h-full items-start gap-2.5 rounded-control border border-border bg-surface px-3 py-2.5 transition-colors hover:border-border-strong hover:bg-surface-hover">
                <span aria-hidden className={cn('mt-0.5 shrink-0 [&>svg]:h-4 [&>svg]:w-4', item.kind === 'wake' ? 'text-warning' : 'text-accent')}>{ICON[item.kind]}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium" title={item.title}>{item.title}</span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-muted">
                    <span className="truncate">{item.kind === 'wake' && item.detail ? item.detail : [t(KIND_LABEL[item.kind]), item.detail].filter(Boolean).join(' · ')}</span>
                    <span className="ml-auto flex shrink-0 items-center gap-1 tabular-nums">
                      {item.kind === 'wake'
                        ? <time dateTime={item.since} title={formatDateTime(item.since)}>{formatAge(item.since)}</time>
                        : <><span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent motion-reduce:animate-none" /><Elapsed since={item.since} /></>}
                    </span>
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </InboxSection>
  )
}
