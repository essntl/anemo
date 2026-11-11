import { addDays } from '@/features/tasks/dates'
import { dateLocale, t } from '@/lib/i18n'
import type { Bar } from './BarChart'
import type { DayValue } from './api'

export type RangeKind = 'week' | 'month' | 'half' | 'custom'

/** The days a range covers, ending today: 7, 30 or 182 days. */
export function rangeFor(kind: Exclude<RangeKind, 'custom'>, today: string): { from: string; to: string } {
  const days = kind === 'week' ? 7 : kind === 'month' ? 30 : 182
  return { from: addDays(today, -(days - 1)), to: today }
}

const date = (day: string) => new Date(`${day}T12:00:00`)

/**
 * Bars for a series of days. Up to 62 days: one bar per day. Longer: one bar per week
 * (starting on Monday), so six months stay readable.
 */
export function toBars(series: DayValue[], today: string): Bar[] {
  if (series.length <= 62) {
    return series.map((d) => ({
      key: d.day,
      label: date(d.day).toLocaleDateString(dateLocale(), { weekday: 'short', day: 'numeric', month: 'short' }),
      short: series.length > 7 ? String(date(d.day).getDate()) : date(d.day).toLocaleDateString(dateLocale(), { weekday: 'narrow' }),
      value: d.value,
      highlight: d.day === today,
    }))
  }
  const weeks: { start: string; value: number; today: boolean }[] = []
  for (const d of series) {
    const monday = addDays(d.day, -((date(d.day).getDay() + 6) % 7))
    const last = weeks.at(-1)
    if (last && last.start === monday) {
      last.value += d.value
      last.today ||= d.day === today
    } else weeks.push({ start: monday, value: d.value, today: d.day === today })
  }
  return weeks.map((w) => ({
    key: w.start,
    label: t('Week of {date}', { date: date(w.start).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' }) }),
    short: date(w.start).toLocaleDateString(dateLocale(), { month: 'short' }).slice(0, 3),
    value: w.value,
    highlight: w.today,
  }))
}
