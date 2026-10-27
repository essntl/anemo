import { Pause, Play, RotateCcw, StepForward } from 'lucide-react'
import { RollingText } from '@/components/ui/RollingText'
import { cn } from '@/lib/cn'
import { formatClock, PHASE_COLOR, PHASE_LABEL } from '../timer'
import { timerActions, useTimer } from '../timerStore'

/** The dots under the clock: one per focus session of the cycle, the current one long. */
export function SessionDots({ className }: { className?: string }) {
  const t = useTimer()
  const total = Math.max(1, t.prefs.roundsBeforeLongBreak)
  const color = PHASE_COLOR[t.phase]
  // During a break: the session just finished (a long break follows the last one).
  const number = t.phase === 'focus' ? t.cycleIndex + 1 : t.cycleIndex || total
  return (
    <span className={cn('flex gap-1.5', className)} role="img" aria-label={`Session ${number} of ${total}`}>
      {Array.from({ length: total }, (_, i) => {
        const done = i < t.cycleIndex
        const current = i === t.cycleIndex && t.phase === 'focus'
        return (
          <span key={i}
            className={cn('h-1.5 rounded-full transition-[width,background-color] duration-300 motion-reduce:transition-none', current ? 'w-[18px]' : 'w-1.5')}
            style={{ background: done || current ? color : 'var(--border-strong)', opacity: done ? 0.6 : 1 }} />
        )
      })}
    </span>
  )
}

const round = 'flex shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted transition-colors hover:bg-surface-hover hover:text-text'

/**
 * The large timer: a progress ring with the phase and the clock in the middle, the
 * session dots, and reset · start/pause · skip under it. `md` is the Home widget size.
 */
export function TimerDial({ size = 'lg' }: { size?: 'lg' | 'md' }) {
  const t = useTimer()
  const px = size === 'lg' ? 256 : 176
  const stroke = size === 'lg' ? 12 : 9
  const r = (px - stroke) / 2
  const c = 2 * Math.PI * r
  const color = PHASE_COLOR[t.phase]

  return (
    <div className="flex flex-col items-center">
      <div className="relative" style={{ width: px, height: px }}>
        {/* A soft glow in the phase colour, brighter while running. */}
        <div aria-hidden className="absolute -inset-[8%] rounded-full transition-opacity duration-500"
          style={{ background: `radial-gradient(closest-side, ${color}, transparent)`, opacity: t.running ? 0.18 : 0.06 }} />
        <svg width={px} height={px} className="relative -rotate-90" aria-hidden>
          <circle cx={px / 2} cy={px / 2} r={r} fill="none" stroke="var(--ring-track)" strokeWidth={stroke} />
          <circle cx={px / 2} cy={px / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
            strokeDasharray={c} strokeDashoffset={c * (1 - t.progress)}
            className="transition-[stroke-dashoffset,stroke] duration-300 ease-linear motion-reduce:transition-none" />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="mb-1 text-[11.5px] font-semibold uppercase tracking-[0.14em]" style={{ color }}>
            {t.status === 'paused' ? 'Paused' : PHASE_LABEL[t.phase]}
          </span>
          <RollingText value={formatClock(t.remaining)}
            className={cn('font-semibold leading-none tracking-tight', size === 'lg' ? 'text-[56px]' : 'text-[38px]')} />
          <SessionDots className="mt-3" />
        </div>
      </div>

      <div className={cn('flex items-center gap-4', size === 'lg' ? 'mt-5' : 'mt-3')}>
        <button type="button" aria-label="Reset timer" title="Reset (R)" onClick={timerActions.reset}
          className={cn(round, size === 'lg' ? 'h-12 w-12' : 'h-10 w-10 pointer-coarse:h-11 pointer-coarse:w-11')}>
          <RotateCcw className="h-5 w-5" />
        </button>
        <button type="button" onClick={timerActions.toggle} aria-label={t.running ? 'Pause timer' : 'Start timer'}
          title={t.running ? 'Pause (Space)' : 'Start (Space)'}
          className={cn('flex shrink-0 items-center justify-center rounded-full text-accent-contrast shadow-soft transition-transform active:scale-95 motion-reduce:transition-none',
            size === 'lg' ? 'h-16 w-16 [&>svg]:h-7 [&>svg]:w-7' : 'h-[52px] w-[52px] [&>svg]:h-6 [&>svg]:w-6')}
          style={{ background: color }}>
          {t.running ? <Pause fill="currentColor" /> : <Play fill="currentColor" className="translate-x-0.5" />}
        </button>
        <button type="button" aria-label="Skip to the next phase" title="Skip (S)" onClick={timerActions.skip}
          className={cn(round, size === 'lg' ? 'h-12 w-12' : 'h-10 w-10 pointer-coarse:h-11 pointer-coarse:w-11')}>
          <StepForward className="h-5 w-5" />
        </button>
      </div>
    </div>
  )
}
