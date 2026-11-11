import { useToday } from '@/hooks/useNow'
import { useMemo } from 'react'
import { ChartColumn } from 'lucide-react'
import { useScope } from '@/app/projectStore'
import { dateLocale, rich, t } from '@/lib/i18n'
import { formatMinutes, useFocusSessions } from '@/features/focus/api'
import { useSettings } from '@/features/settings/api'
import { BarChart } from '@/features/stats/BarChart'
import { dayOf } from '@/features/tasks/dates'
import { startOfWeek } from '../dates'
import type { WidgetLayout } from '../layout'
import { WidgetHeader } from './parts'

/** This week: focused minutes per day, Monday to Sunday, with the total and the goal. */
export function WeekWidget({ item }: { item: WidgetLayout }) {
  const scope = useScope()
  const project = scope.kind === 'project' ? scope.project : null
  const goal = useSettings().data?.focus.daily_goal_minutes ?? 0
  const day = useToday()
  const start = useMemo(() => startOfWeek(new Date(day)), [day])
  const end = useMemo(() => new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7), [start])
  const sessions = useFocusSessions({ start, end, projectId: project?.id, noProject: scope.kind === 'uncategorized' })
  const today = dayOf(new Date(day))
  const bars = useMemo(() => {
    const byDay = new Map<string, number>()
    for (const s of sessions.data ?? []) {
      const key = dayOf(new Date(s.started_at))
      byDay.set(key, (byDay.get(key) ?? 0) + s.minutes)
    }
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
      const key = dayOf(d)
      return {
        key,
        label: d.toLocaleDateString(dateLocale(), { weekday: 'long', day: 'numeric', month: 'short' }),
        short: d.toLocaleDateString(dateLocale(), { weekday: 'narrow' }),
        value: byDay.get(key) ?? 0,
        highlight: key === today,
      }
    })
  }, [sessions.data, start, today])
  const total = bars.reduce((s, b) => s + b.value, 0)
  return (
    <>
      <WidgetHeader title={t('This week')} icon={<ChartColumn />} to="/stats">
        <span className="text-[12px] text-muted tabular-nums">
          {goal > 0
            ? rich('<b>{done}</b> of {goal}', { b: (c) => <span className="font-semibold text-text">{c}</span> }, { done: formatMinutes(total), goal: formatMinutes(goal * 7) })
            : <span className="font-semibold text-text">{formatMinutes(total)}</span>}
        </span>
      </WidgetHeader>
      <div className="flex-1 px-4 pb-4 pt-2">
        <BarChart data={bars} goal={goal || undefined} height={item.h === 1 ? 72 : item.h === 2 ? 220 : 380} />
      </div>
    </>
  )
}
