import { useToday } from '@/hooks/useNow'
import { useMemo } from 'react'
import { Link } from 'react-router'
import { CalendarClock } from 'lucide-react'
import { useCurrentProject } from '@/app/projectStore'
import { cn } from '@/lib/cn'
import { useOccurrences } from '@/features/calendar/api'
import { useTasks } from '@/features/tasks/api'
import { addDays, dayOf, formatDay } from '@/features/tasks/dates'
import { dayRange, timeOf } from '../dates'
import type { WidgetLayout } from '../layout'
import { ROWS } from './rows'
import { MoreLink, WidgetHeader } from './parts'

interface Item { key: string; day: string; time: string; title: string; to: string; color?: string; task?: boolean }

/** Upcoming: the next 7 days of events and dated tasks, by day. */
export function UpcomingWidget({ item }: { item: WidgetLayout }) {
  const project = useCurrentProject()
  const day = useToday()
  const range = useMemo(() => dayRange(new Date(day), 8), [day])
  const events = useOccurrences(range, project?.id ?? null)
  const tasks = useTasks()
  const today = dayOf(new Date(day))
  const items = useMemo(() => {
    const last = addDays(today, 7)
    const out: Item[] = [
      ...(events.data ?? []).map((e) => {
        const day = e.all_day ? (e.start_date ?? dayOf(new Date(e.start_at))) : dayOf(new Date(e.start_at))
        return { key: `e-${e.id}-${e.start_at}`, day, time: e.all_day ? '' : timeOf(e.start_at), title: e.title, to: `/calendar?date=${day}`, color: e.color ?? undefined }
      }),
      ...(tasks.data ?? [])
        .filter((t) => t.due_date && t.due_date >= today && t.due_date <= last && t.status !== 'done' && t.status !== 'cancelled')
        .filter((t) => !project || t.project_id === project.id)
        .map((t) => ({ key: `t-${t.id}`, day: t.due_date!, time: t.due_time?.slice(0, 5) ?? '', title: t.title, to: `/tasks?task=${t.id}`, task: true })),
    ]
    return out.filter((i) => i.day >= today && i.day <= last).sort((a, b) => a.day.localeCompare(b.day) || a.time.localeCompare(b.time))
  }, [events.data, tasks.data, project, today])

  const rows = ROWS[item.h] + 1
  const shown = items.slice(0, rows)
  const wide = item.w > 1
  const days = [...new Set(shown.map((i) => i.day))]
  return (
    <>
      <WidgetHeader title="Upcoming" icon={<CalendarClock />} to="/calendar" />
      <div className="flex-1 px-2 pb-3">
        {events.isSuccess && tasks.isSuccess && items.length === 0 && (
          <p className="px-2 py-2 text-[13px] text-muted">Nothing in the next 7 days.</p>
        )}
        <div className={cn(wide && 'grid grid-cols-2 gap-x-3')}>
          {days.map((day) => (
            <section key={day} className="mb-1">
              <h3 className="px-2 pt-1 text-[11px] font-semibold uppercase tracking-wider text-subtle">{formatDay(day, today)}</h3>
              <ul>
                {shown.filter((i) => i.day === day).map((i) => (
                  <li key={i.key}>
                    <Link to={i.to} className="flex items-center gap-2.5 rounded-control px-2 py-1 hover:bg-surface-hover">
                      <span className={cn('h-4 w-1 shrink-0 rounded-full', i.task && 'border border-dashed border-border-strong')}
                        style={i.task ? undefined : { background: i.color ?? 'var(--accent)' }} />
                      <span className="min-w-0 flex-1 truncate text-[13px]">{i.title}</span>
                      {i.time && <span className="shrink-0 text-[11.5px] text-muted tabular-nums">{i.time}</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <MoreLink to="/calendar" count={items.length - shown.length} />
      </div>
    </>
  )
}
