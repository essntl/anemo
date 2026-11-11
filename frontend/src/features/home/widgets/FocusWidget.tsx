import { Pause, Play, RotateCcw, StepForward, Timer } from 'lucide-react'
import { RollingText } from '@/components/ui/RollingText'
import { Ring } from '@/components/ui/Ring'
import { useScope } from '@/app/projectStore'
import { formatMinutes, useTodayFocus } from '@/features/focus/api'
import { TaskPicker } from '@/features/focus/components/TaskPicker'
import { TimerDial } from '@/features/focus/components/TimerDial'
import { formatClock, PHASE_COLOR, PHASE_LABEL } from '@/features/focus/timer'
import { timerActions, useTimer } from '@/features/focus/timerStore'
import { rich, t } from '@/lib/i18n'
import type { WidgetLayout } from '../layout'
import { WidgetHeader } from './parts'

const small = 'flex h-9 w-9 items-center justify-center rounded-full bg-surface-2 text-muted hover:bg-surface-hover hover:text-text pointer-coarse:h-11 pointer-coarse:w-11'

/** Focus: the dial with its controls (a single row when the widget is one row tall). */
export function FocusWidget({ item }: { item: WidgetLayout }) {
  const timer = useTimer()
  const scope = useScope()
  const project = scope.kind === 'project' ? scope.project : null
  const today = useTodayFocus(project?.id, scope.kind === 'uncategorized')
  const minutes = (
    <p className="text-[13px] text-muted">
      {project
        ? rich('<b>{minutes}</b> focused today in {project}', { b: (c) => <span className="font-semibold text-text tabular-nums">{c}</span> }, { minutes: formatMinutes(today.minutes), project: project.name })
        : rich('<b>{minutes}</b> focused today', { b: (c) => <span className="font-semibold text-text tabular-nums">{c}</span> }, { minutes: formatMinutes(today.minutes) })}
    </p>
  )
  return (
    <>
      <WidgetHeader title={t('Focus')} icon={<Timer />} to="/focus" />
      {item.h === 1 ? (
        <div className="flex flex-1 flex-col justify-center gap-2 px-4 pb-4">
          <div className="flex items-center gap-3">
            <Ring progress={timer.progress} size={44} stroke={4} color={PHASE_COLOR[timer.phase]} track="var(--ring-track)" />
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: PHASE_COLOR[timer.phase] }}>
                {timer.status === 'paused' ? t('Paused') : t(PHASE_LABEL[timer.phase])}
              </div>
              <RollingText value={formatClock(timer.remaining)} className="text-[24px] font-semibold leading-none" />
            </div>
            <button type="button" className={small} aria-label={t('Reset timer')} onClick={timerActions.reset}><RotateCcw className="h-4 w-4" /></button>
            <button type="button" aria-label={timer.running ? t('Pause timer') : t('Start timer')} onClick={timerActions.toggle}
              className="flex h-10 w-10 items-center justify-center rounded-full text-accent-contrast pointer-coarse:h-11 pointer-coarse:w-11" style={{ background: PHASE_COLOR[timer.phase] }}>
              {timer.running ? <Pause className="h-4 w-4" fill="currentColor" /> : <Play className="h-4 w-4 translate-x-px" fill="currentColor" />}
            </button>
            <button type="button" className={small} aria-label={t('Skip to the next phase')} onClick={timerActions.skip}><StepForward className="h-4 w-4" /></button>
          </div>
          {minutes}
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 pb-5">
          <TimerDial size="md" />
          {minutes}
          <TaskPicker className="max-w-full justify-center" />
        </div>
      )}
    </>
  )
}
