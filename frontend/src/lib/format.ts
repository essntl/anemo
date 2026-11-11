/** Small display formatters shared across pages. */
import { dateLocale, t } from '@/lib/i18n'

/** 42 → "42 s", 185 → "3 min 5 s", 7300 → "2 h 1 min". */
export function formatDuration(seconds: number): string {
  const s = Math.round(seconds)
  if (s < 60) return t('{s} s', { s })
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? t('{m} min {s} s', { m, s: s % 60 }) : t('{m} min', { m })
  const h = Math.floor(m / 60)
  return m % 60 ? t('{h} h {m} min', { h, m: m % 60 }) : t('{h} h', { h })
}

/** "14:03" today, "Yesterday 14:03", otherwise "12 Sep 14:03" (with the year if not this year). */
export function formatWhen(iso: string, now = new Date()): string {
  const d = new Date(iso)
  const time = d.toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' })
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (d.getTime() >= startOfToday) return time
  if (d.getTime() >= startOfToday - 86_400_000) return t('Yesterday {time}', { time })
  const date = d.toLocaleDateString(dateLocale(), {
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  })
  return `${date} ${time}`
}

/** The day a date falls on, for list headings: "Today", "Yesterday", "Past week"
 *  (2 to 7 days ago), otherwise the date: "12 Sep" (with the year if not this year). */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso)
  // Calendar days, not 24-hour blocks, so it stays right when the clocks change.
  const daysAgo = (n: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - n).getTime()
  if (d.getTime() >= daysAgo(0)) return t('Today')
  if (d.getTime() >= daysAgo(1)) return t('Yesterday')
  if (d.getTime() >= daysAgo(7)) return t('Past week')
  return d.toLocaleDateString(dateLocale(), {
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  })
}

/** null (unknown price) → "unknown"; tiny amounts keep enough digits to be useful. */
export function formatCost(usd: number | null | undefined): string {
  if (usd == null) return t('unknown')
  if (usd === 0) return '$0'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

/** 950 → "950", 12_345 → "12.3k", 2_500_000 → "2.5M". */
export function formatCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return t('{n}k', { n: (n / 1000).toFixed(n < 10_000 ? 1 : 0) })
  return t('{n}M', { n: (n / 1_000_000).toFixed(1) })
}

/** A time that is still to come: "Today 14:03", "Tomorrow 08:00", otherwise "Mon 12 Sep 08:00". */
export function formatUpcoming(iso: string, now = new Date()): string {
  const d = new Date(iso)
  const time = d.toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' })
  // Calendar days, not 24-hour blocks: a day with a daylight-saving change is 23 or 25 hours.
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfThatDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOfThatDay - startOfToday) / 86_400_000)
  if (days === 0) return t('Today {time}', { time })
  if (days === 1) return t('Tomorrow {time}', { time })
  const date = d.toLocaleDateString(dateLocale(), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  })
  return `${date} ${time}`
}

/**
 * A file size: 512 B, 12 KB, 3.4 MB. `kbDecimals: 1` gives 12.1 KB (the file manager's
 * size column). An unknown size is an empty string.
 */
export function formatSize(bytes: number | null | undefined, opts: { kbDecimals?: 0 | 1 } = {}): string {
  if (bytes == null) return ''
  if (bytes < 1024) return t('{n} B', { n: bytes })
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024
    return t('{n} KB', { n: opts.kbDecimals ? kb.toFixed(opts.kbDecimals) : Math.round(kb) })
  }
  return t('{n} MB', { n: (bytes / 1024 / 1024).toFixed(1) })
}
