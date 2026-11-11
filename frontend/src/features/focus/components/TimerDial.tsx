import { Pause, Play, RotateCcw, StepForward } from 'lucide-react'
import { RollingText } from '@/components/ui/RollingText'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { formatClock, PHASE_COLOR, PHASE_LABEL } from '../timer'
import { timerActions, useTimer } from '../timerStore'

/** The dots under the clock: one per focus session of the cycle, the current one long. */
export function SessionDots({ className }: { className?: string }) {
  const timer = useTimer()
  const total = Math.max(1, timer.prefs.roundsBeforeLongBreak)
  const color = PHASE_COLOR[timer.phase]
  // During a break: the session just finished (a long break follows the last one).
  const number = timer.phase === 'focus' ? timer.cycleIndex + 1 : timer.cycleIndex || total
  return (
    <span className={cn('flex gap-1.5', className)} role="img" aria-label={t('Session {number} of {total}', { number, total })}>
      {Array.from({ length: total }, (_, i) => {
        const done = i < timer.cycleIndex
        const current = i === timer.cycleIndex && timer.phase === 'focus'
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
  const timer = useTimer()
  const px = size === 'lg' ? 256 : 176
  const stroke = size === 'lg' ? 12 : 9
  const r = (px - stroke) / 2
  const c = 2 * Math.PI * r
  const color = PHASE_COLOR[timer.phase]

  return (
    <div className="flex flex-col items-center">
      <div className="relative" style={{ width: px, height: px }}>
        {/* A soft glow in the phase colour, brighter while running. */}
        <div aria-hidden className="absolute -inset-[8%] rounded-full transition-opacity duration-500"
          style={{ background: `radial-gradient(closest-side, ${color}, transparent)`, opacity: timer.running ? 0.18 : 0.06 }} />
        <svg width={px} height={px} className="relative -rotate-90" aria-hidden>
          <circle cx={px / 2} cy={px / 2} r={r} fill="none" stroke="var(--ring-track)" strokeWidth={stroke} />
          <circle cx={px / 2} cy={px / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
            strokeDasharray={c} strokeDashoffset={c * (1 - timer.progress)}
            className="transition-[stroke-dashoffset,stroke] duration-300 ease-linear motion-reduce:transition-none" />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="mb-1 text-[11.5px] font-semibold uppercase tracking-[0.14em]" style={{ color }}>
            {timer.status === 'paused' ? t('Paused') : t(PHASE_LABEL[timer.phase])}
          </span>
          <RollingText value={formatClock(timer.remaining)}
            className={cn('font-semibold leading-none tracking-tight', size === 'lg' ? 'text-[56px]' : 'text-[38px]')} />
          <SessionDots className="mt-3" />
        </div>
      </div>

      <div className={cn('flex items-center gap-4', size === 'lg' ? 'mt-5' : 'mt-3')}>
        <button type="button" aria-label={t('Reset timer')} title={t('Reset (R)')} onClick={timerActions.reset}
          className={cn(round, size === 'lg' ? 'h-12 w-12' : 'h-10 w-10 pointer-coarse:h-11 pointer-coarse:w-11')}>
          <RotateCcw className="h-5 w-5" />
        </button>
        <button type="button" onClick={timerActions.toggle} aria-label={timer.running ? t('Pause timer') : t('Start timer')}
          title={timer.running ? t('Pause (Space)') : t('Start (Space)')}
          className={cn('flex shrink-0 items-center justify-center rounded-full text-accent-contrast shadow-soft transition-transform active:scale-95 motion-reduce:transition-none',
            size === 'lg' ? 'h-16 w-16 [&>svg]:h-7 [&>svg]:w-7' : 'h-[52px] w-[52px] [&>svg]:h-6 [&>svg]:w-6')}
          style={{ background: color }}>
          {timer.running ? <Pause fill="currentColor" /> : <Play fill="currentColor" className="translate-x-0.5" />}
        </button>
        <button type="button" aria-label={t('Skip to the next phase')} title={t('Skip (S)')} onClick={timerActions.skip}
          className={cn(round, size === 'lg' ? 'h-12 w-12' : 'h-10 w-10 pointer-coarse:h-11 pointer-coarse:w-11')}>
          <StepForward className="h-5 w-5" />
        </button>
      </div>
    </div>
  )
}
