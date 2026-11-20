/**
 * How long an answer takes: the live timer while it is written, and the duration
 * once it is done (with the details on hover or click). See ../timing.ts.
 */
import { useState } from 'react'
import { Pause } from 'lucide-react'
import { Elapsed } from '@/components/ui/Elapsed'
import { cn } from '@/lib/cn'
import { formatDuration } from '@/lib/format'
import { t } from '@/lib/i18n'
import { type RunTiming, durationMs, firstTextMs, workedUntilWaitingMs } from '../timing'

const timer = (ms: number) => formatDuration(ms / 1000, { style: 'timer' })

/**
 * The elapsed time of the answer being written, counting up every second. While the run
 * waits for you it stands still and says so; that time is not counted.
 */
export function LiveTiming({ timing, paused = false }: { timing: RunTiming; paused?: boolean }) {
  if (timing.waiting_since) {
    return (
      <span className="inline-flex items-center gap-1 text-tool-waiting">
        <Pause className="h-3 w-3" aria-hidden />
        <span className="tabular-nums">{timer(workedUntilWaitingMs(timing))}</span>
        <span>· {paused ? t('paused') : t('waiting for you')}</span>
      </span>
    )
  }
  return <Elapsed since={timing.started_at} minusMs={timing.waiting_ms} />
}

/**
 * How long a finished answer took ("41 s"), quiet beside its model; a stopped or failed
 * one says so. Hovering or clicking shows the details.
 */
export function AnswerDuration({ timing }: { timing: RunTiming }) {
  const [pinned, setPinned] = useState(false)
  const [hovered, setHovered] = useState(false)
  const total = durationMs(timing)
  if (total === null) return null
  const duration = timer(total)
  const label =
    timing.outcome === 'stopped' ? t('Stopped after {duration}', { duration })
      : timing.outcome === 'failed' ? t('Failed after {duration}', { duration })
        : duration
  const first = firstTextMs(timing)
  const open = pinned || hovered
  return (
    <span className="relative mr-2 shrink-0" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <button type="button" aria-expanded={open} aria-label={t('How long the answer took: {duration}', { duration: label })}
        onClick={() => setPinned(!pinned)} onBlur={() => setPinned(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setPinned(false)
            setHovered(false)
          }
        }}
        className={cn('rounded-md px-1.5 py-0.5 tabular-nums hover:bg-surface-hover hover:text-text',
          timing.outcome !== 'done' && 'rounded-full bg-surface-2 px-2 text-muted')}>
        {label}
      </button>
      {open && (
        <div role="tooltip" className="absolute bottom-full left-0 z-20 mb-1.5 w-60 rounded-lg border border-border bg-surface p-2.5 text-[12px] text-text shadow-float">
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
            <dt className="text-muted">{t('Total')}</dt>
            <dd className="text-right tabular-nums">{duration}</dd>
            <dt className="text-muted">{t('Time to first text')}</dt>
            <dd className="text-right tabular-nums">{first === null ? '–' : timer(first)}</dd>
            <dt className="text-muted">{t('Waiting for you')}</dt>
            <dd className="text-right tabular-nums">{timer(timing.waiting_ms)}</dd>
            <dt className="text-muted">{t('Tool calls')}</dt>
            <dd className="text-right tabular-nums">{timing.tool_calls}</dd>
          </dl>
          <p className="mt-1.5 text-subtle">{t('The time spent waiting for you is not part of the total.')}</p>
        </div>
      )}
    </span>
  )
}
