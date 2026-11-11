/**
 * A short title for the calendar on a phone, where the top bar also holds the arrows and
 * buttons: "Nov 2026" for a month, "Nov 10 – 12" for a few days, "Nov 11" for one.
 * `range` is the days shown, as YYYY-MM-DD, the end not included.
 */
export function shortTitle(range: { start: string; end: string }, month: boolean, locale?: string): string {
  const start = new Date(`${range.start}T00:00:00`)
  if (month) return new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric' }).format(start)
  const last = new Date(`${range.end}T00:00:00`)
  last.setDate(last.getDate() - 1)
  const days = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' })
  return last <= start ? days.format(start) : days.formatRange(start, last)
}
