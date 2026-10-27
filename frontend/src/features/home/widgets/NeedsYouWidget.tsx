import { Link } from 'react-router'
import { AlarmClock, Brain, Clock, Inbox, Pin, PinOff, ShieldQuestion } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import type { WidgetLayout } from '../layout'
import { type NeedsRow, useNeedsYou } from '../useNeedsYou'
import { ROWS } from './rows'
import { MoreLink, WidgetHeader } from './parts'

const ICON: Record<NeedsRow['kind'], ReactNode> = {
  approval: <ShieldQuestion />,
  memory: <Brain />,
  automation: <Clock />,
  overdue: <AlarmClock />,
}

/** Needs you: approvals, memory suggestions, failed automations, overdue tasks. */
export function NeedsYouWidget({ item, onPin }: { item: WidgetLayout; onPin: (pinned: boolean) => void }) {
  const { rows } = useNeedsYou()
  const n = ROWS[item.h] + 1
  return (
    <>
      <WidgetHeader title="Needs you" icon={<Inbox />}>
        {rows.length > 0 && <span className="rounded-full bg-warning px-2 py-0.5 text-[11px] font-semibold text-white">{rows.length}</span>}
        <button type="button" onClick={() => onPin(!item.pinned)} aria-pressed={!!item.pinned}
          aria-label={item.pinned ? 'Hide when there is nothing' : 'Keep showing when there is nothing'}
          title={item.pinned ? 'Pinned: shown even when empty' : 'Hidden when there is nothing'}
          className={cn('flex h-8 w-8 items-center justify-center rounded-full hover:bg-surface-hover pointer-coarse:h-10 pointer-coarse:w-10', item.pinned ? 'text-accent' : 'text-muted')}>
          {item.pinned ? <Pin className="h-4 w-4" /> : <PinOff className="h-4 w-4" />}
        </button>
      </WidgetHeader>
      <div className="flex-1 px-2 pb-3">
        {rows.length === 0 && <p className="px-2 py-2 text-[13px] text-muted">Nothing needs you right now.</p>}
        <ul>
          {rows.slice(0, n).map((r) => (
            <li key={r.key}>
              <Link to={r.to} className="flex items-center gap-2.5 rounded-control px-2 py-1.5 hover:bg-surface-hover">
                <span className={cn('shrink-0 [&>svg]:h-4 [&>svg]:w-4', r.kind === 'overdue' || r.kind === 'automation' ? 'text-error' : 'text-warning')}>{ICON[r.kind]}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium">{r.title}</span>
                  {r.detail && <span className="block truncate text-[12px] text-muted">{r.detail}</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
        <MoreLink to="/notifications" count={rows.length - n} />
      </div>
    </>
  )
}
