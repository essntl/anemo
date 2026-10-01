/** Small display formatters shared across pages. */

/** 42 → "42 s", 185 → "3 min 5 s", 7300 → "2 h 1 min". */
export function formatDuration(seconds: number): string {
  const s = Math.round(seconds)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`
}

/** "14:03" today, "Yesterday 14:03", otherwise "12 Sep 14:03" (with the year if not this year). */
export function formatWhen(iso: string, now = new Date()): string {
  const d = new Date(iso)
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (d.getTime() >= startOfToday) return time
  if (d.getTime() >= startOfToday - 86_400_000) return `Yesterday ${time}`
  const date = d.toLocaleDateString(undefined, {
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
  if (d.getTime() >= daysAgo(0)) return 'Today'
  if (d.getTime() >= daysAgo(1)) return 'Yesterday'
  if (d.getTime() >= daysAgo(7)) return 'Past week'
  return d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  })
}

/** null (unknown price) → "unknown"; tiny amounts keep enough digits to be useful. */
export function formatCost(usd: number | null | undefined): string {
  if (usd == null) return 'unknown'
  if (usd === 0) return '$0'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

/** 950 → "950", 12_345 → "12.3k", 2_500_000 → "2.5M". */
export function formatCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** A time that is still to come: "Today 14:03", "Tomorrow 08:00", otherwise "Mon 12 Sep 08:00". */
export function formatUpcoming(iso: string, now = new Date()): string {
  const d = new Date(iso)
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const days = Math.floor((d.getTime() - startOfToday) / 86_400_000)
  if (days === 0) return `Today ${time}`
  if (days === 1) return `Tomorrow ${time}`
  const date = d.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  })
  return `${date} ${time}`
}
