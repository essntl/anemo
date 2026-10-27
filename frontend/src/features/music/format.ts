/** "3:07", or "1:02:03" past an hour. */
export function formatSeconds(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return '0:00'
  const m = Math.floor(s / 60)
  const sec = String(Math.floor(s % 60)).padStart(2, '0')
  const h = Math.floor(m / 60)
  return h ? `${h}:${String(m % 60).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

export function trackCount(n: number): string {
  return `${n} track${n === 1 ? '' : 's'}`
}
