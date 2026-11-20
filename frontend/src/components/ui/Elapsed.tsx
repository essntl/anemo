import { useEffect, useState } from 'react'
import { cn } from '@/lib/cn'
import { formatDuration } from '@/lib/format'
import { dateLocale, t } from '@/lib/i18n'
import { serverNow } from '@/lib/serverClock'

interface ElapsedProps {
  /** When it started, as the server recorded it (ISO time). */
  since: string
  /** Time not to count (e.g. spent waiting for you), in milliseconds. */
  minusMs?: number
  className?: string
}

/** Milliseconds from `since` (minus `minusMs`) to the server's time now. */
function elapsedMs(since: string, minusMs = 0, now = serverNow()): number {
  return Math.max(now - Date.parse(since) - minusMs, 0)
}

/**
 * How long something has been going on, counting up once a second ("42 s", "2 m 05 s").
 *
 * Counted on the server's clock, so a reload or another device shows the same time.
 * The count lives here: each tick draws only this element, never the page around it.
 * The timer stops when the element goes (the answer ended or the chat closed).
 */
export function Elapsed({ since, minusMs = 0, className }: ElapsedProps) {
  const [now, setNow] = useState(serverNow)
  useEffect(() => {
    let timer = 0
    // Wait for the next whole second of the count, so the shown seconds change on time.
    const schedule = (current: number) => {
      timer = window.setTimeout(tick, 1000 - (elapsedMs(since, minusMs, current) % 1000))
    }
    const tick = () => {
      const current = serverNow()
      setNow(current)
      schedule(current)
    }
    schedule(serverNow())
    return () => window.clearTimeout(timer)
  }, [since, minusMs])
  const started = new Date(since).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' })
  return (
    <span className={cn('tabular-nums', className)}>
      {/* Screen readers get a text that stays the same, not a new number every second. */}
      <span aria-hidden="true">{formatDuration(elapsedMs(since, minusMs, now) / 1000, { style: 'timer' })}</span>
      <span className="sr-only">{t('running since {time}', { time: started })}</span>
    </span>
  )
}
