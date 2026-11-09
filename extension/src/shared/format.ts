/** "14:05" today, "Yesterday 14:05", otherwise "12 Sep 14:05" (as Anemo's lib/format.ts). */
export function formatWhen(iso: string, now = new Date()): string {
  const d = new Date(iso)
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (d.getTime() >= startOfToday) return time
  if (d.getTime() >= startOfToday - 86_400_000) return `Yesterday ${time}`
  const date = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })
  return `${date} ${time}`
}

/** The group a chat goes in by its last message: "Today", "Yesterday", "Past week", or
 *  its month ("September 2026"), as Anemo's chat list. */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso)
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const t = d.getTime()
  if (t >= startOfToday) return 'Today'
  if (t >= startOfToday - 86_400_000) return 'Yesterday'
  if (t >= startOfToday - 6 * 86_400_000) return 'Past week'
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

/** Time left as "4:59" (clock) or "5m" / "40s" (short). */
export function formatRemaining(ms: number, style: 'clock' | 'short'): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  if (style === 'clock') return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
  return total >= 60 ? `${Math.ceil(total / 60)}m` : `${total}s`
}
