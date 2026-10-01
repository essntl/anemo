/** The periods offered on the Usage page, and the days inside a period (for the chart). */

export type RangeId = 'today' | '7d' | '30d' | 'month' | 'all'

export const RANGES: { id: RangeId; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: 'month', label: 'This month' },
  { id: 'all', label: 'All time' },
]

export interface Range {
  /** ISO instants; null means "no limit". `end` is exclusive. */
  start: string | null
  end: string | null
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())

/** The period in this browser's time zone: days start at local midnight. */
export function rangeFor(id: RangeId, now = new Date()): Range {
  const tomorrow = startOfDay(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const end = tomorrow.toISOString()
  const daysBack = (days: number) => {
    const start = startOfDay(now)
    start.setDate(start.getDate() - (days - 1))
    return start.toISOString()
  }
  switch (id) {
    case 'today':
      return { start: daysBack(1), end }
    case '7d':
      return { start: daysBack(7), end }
    case '30d':
      return { start: daysBack(30), end }
    case 'month':
      return { start: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(), end }
    default:
      return { start: null, end: null }
  }
}

const pad = (n: number) => String(n).padStart(2, '0')
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/**
 * Every day (YYYY-MM-DD, local) from the start of the range up to today, so the
 * chart also shows days on which nothing happened. For "all time" there is no
 * start: only the days that have data are shown, hence null.
 */
export function daysIn(range: Range): string[] | null {
  if (!range.start || !range.end) return null
  const days: string[] = []
  const end = new Date(range.end)
  for (let d = new Date(range.start); d < end; d.setDate(d.getDate() + 1)) days.push(dayKey(d))
  return days
}

/** "2026-10-03" → "3 Oct". */
export function dayLabel(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
