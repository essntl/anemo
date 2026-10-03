import { useEffect, useState } from 'react'

/** The current time, updated every `ms` milliseconds (for countdowns). */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms)
    return () => window.clearInterval(t)
  }, [ms])
  return now
}

/**
 * Time left, for temporary chats.
 *   'clock': 272_000 → "4:32"   (the bar in the chat, counting each second)
 *   'short': 272_000 → "5m", 30_000 → "<1m"   (the sidebar, a glance)
 */
export function formatRemaining(ms: number, style: 'clock' | 'short'): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  if (style === 'clock') return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  return seconds < 60 ? '<1m' : `${Math.ceil(seconds / 60)}m`
}
