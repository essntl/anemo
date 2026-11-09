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
