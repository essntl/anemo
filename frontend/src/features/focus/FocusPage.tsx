/**
 * Focus: the timer in full. A large dial, the phase switch, +1 min, the task this
 * focus is for, what you focused on today and the timer's settings.
 * Space starts and pauses, R resets, S skips, + adds a minute.
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { BellRing, Check, ChevronDown, Clock, Flame, Plus, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Segmented } from '@/components/ui/Segmented'
import { ShortcutKeys } from '@/features/shortcuts/ShortcutKeys'
import { useShortcut } from '@/hooks/useShortcut'
import { cn } from '@/lib/cn'
import { dateLocale, plural, rich, t } from '@/lib/i18n'
import { desktopEnabled } from '@/features/notifications/desktop'
import { useTasks } from '@/features/tasks/api'
import { formatMinutes, useTodayFocus } from './api'
import { TaskPicker } from './components/TaskPicker'
import { UpNext } from './components/UpNext'
import { focusQueue } from './queueStore'
import { TimerDial } from './components/TimerDial'
import { TimerSettingsForm } from './components/TimerSettingsForm'
import { PHASE_LABEL, type Phase } from './timer'
import { timerActions, useTimer, useTimerStore } from './timerStore'
import { useSettings } from '@/features/settings/api'
import { useToggleDone } from '@/features/tasks/useToggleDone'
import { PageHeader } from '@/components/ui/PageHeader'


function Today() {
  const today = useTodayFocus()
  const tasks = useTasks()
  const titles = useMemo(() => new Map((tasks.data ?? []).map((t) => [t.id, t.title])), [tasks.data])
  const time = (iso: string) => new Date(iso).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' })
  const goal = useSettings().data?.focus.daily_goal_minutes ?? 0
  return (
    <div className="px-4 pb-4 pt-3 md:px-5">
      <div className="flex items-center justify-between text-[11.5px] font-semibold uppercase tracking-wider text-muted">
        <span className="flex items-center gap-1.5"><Flame className="h-4 w-4" /> {t('Today')}</span>
        <span className="text-[13px] normal-case tracking-normal text-text tabular-nums" data-testid="focus-today">
          {goal > 0
            ? rich('{done}<m> of {goal}</m>', { m: (c) => <span className="font-normal text-muted">{c}</span> }, { done: formatMinutes(today.minutes), goal: formatMinutes(goal) })
            : formatMinutes(today.minutes)}
        </span>
      </div>
      {goal > 0 && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label={t('Today’s focus goal')}
          aria-valuemin={0} aria-valuemax={goal} aria-valuenow={Math.min(today.minutes, goal)}>
          <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, (today.minutes / goal) * 100)}%` }} />
        </div>
      )}
      {today.sessions.length === 0 && !today.waiting ? (
        <p className="pt-2 text-[13px] text-muted">{t('No sessions yet.')}</p>
      ) : (
        <ul className="mt-1 max-h-48 overflow-y-auto">
          {today.sessions.map((s) => (
            <li key={s.id} className="flex items-center gap-2.5 py-1.5 text-[13px]">
              <Clock className="h-3.5 w-3.5 shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate">{(s.task_id && titles.get(s.task_id)) || t('Focus session')}</span>
              <span className="shrink-0 text-muted tabular-nums">
                {s.completed
                  ? t('{time} · {minutes}m', { time: time(s.started_at), minutes: s.minutes })
                  : t('{time} · {minutes}m · cut short', { time: time(s.started_at), minutes: s.minutes })}
              </span>
            </li>
          ))}
          {today.waiting > 0 && (
            <li className="py-1.5 text-[12.5px] text-muted">
              {plural(today.waiting, 'One session is waiting to be saved (offline).', '{n} sessions are waiting to be saved (offline).')}
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

/** Finishes the task the timer is on, and puts the next one from "Up next" in its place. */
function DoneButton() {
  const taskId = useTimerStore((s) => s.timer.taskId)
  const tasks = useTasks()
  const { toggle } = useToggleDone()
  const task = tasks.data?.find((x) => x.id === taskId && x.status !== 'done' && x.status !== 'cancelled')
  if (!task) return null
  const done = async () => {
    await toggle(task)
    const open = new Set((tasks.data ?? []).filter((x) => x.id !== task.id && x.status !== 'done' && x.status !== 'cancelled').map((x) => x.id))
    timerActions.setTask(focusQueue.next(open))
  }
  return (
    <Button size="sm" icon={<Check className="h-3.5 w-3.5" />} title={t('Mark the task done and take the next from Up next')} onClick={() => void done()}>
      {t('Done')}
    </Button>
  )
}

export function FocusPage() {
  const timer = useTimer()
  const [showSettings, setShowSettings] = useState(false)
  useShortcut('focus.toggle', () => timerActions.toggle())
  useShortcut('focus.reset', () => timerActions.reset())
  useShortcut('focus.skip', () => timerActions.skip())
  useShortcut('focus.addMinute', () => timerActions.addMinute())

  return (
    <div className="mx-auto max-w-5xl p-4 md:px-8 md:pb-8 md:pt-2">
      <PageHeader title={t('Focus')}>
        <Link to="/stats" className="shrink-0 text-[13px] font-medium text-accent hover:underline">{t('Stats')}</Link>
      </PageHeader>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card className="flex flex-col items-center bg-linear-to-b from-accent-soft/60 to-card to-55% px-4 py-6 lg:min-h-[34rem] lg:justify-center">
          <Segmented<Phase>
            label={t('Timer phase')}
            className="mb-6"
            value={timer.phase}
            onChange={(p) => p !== timer.phase && timerActions.choosePhase(p)}
            options={(['focus', 'short_break', 'long_break'] as const).map((p) => ({ value: p, label: t(PHASE_LABEL[p]) }))}
          />
          <TimerDial />
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={timerActions.addMinute}>{t('1 min')}</Button>
            <TaskPicker />
            <DoneButton />
          </div>
          <div className="mt-4 hidden flex-wrap items-center justify-center gap-x-3.5 gap-y-1 text-[11.5px] text-muted md:flex">
            <span><ShortcutKeys id="focus.toggle" /> {t('start / pause')}</span>
            <span><ShortcutKeys id="focus.reset" /> {t('reset')}</span>
            <span><ShortcutKeys id="focus.skip" /> {t('skip')}</span>
            <span><ShortcutKeys id="focus.addMinute" /> {t('add a minute')}</span>
          </div>
        </Card>

        <div className="flex flex-col gap-4">
          <Card><Today /></Card>
          <Card><UpNext /></Card>
          <Card>
            <button type="button" aria-expanded={showSettings} onClick={() => setShowSettings((x) => !x)}
              className="flex w-full items-center gap-2 px-4 py-3.5 text-left md:px-5">
              <Settings2 className="h-4 w-4 text-muted" />
              <span className="flex-1 text-[14px] font-semibold">{t('Timer settings')}</span>
              <span className="text-[12px] text-muted tabular-nums">{timer.prefs.focusMinutes} / {timer.prefs.shortBreakMinutes} / {timer.prefs.longBreakMinutes}</span>
              <ChevronDown className={cn('h-4 w-4 text-muted transition-transform', showSettings && 'rotate-180')} />
            </button>
            {showSettings && (
              <div className="border-t border-border px-4 pb-3 pt-3 md:px-5">
                <TimerSettingsForm />
              </div>
            )}
          </Card>
          {!desktopEnabled() && (
            <p className="flex items-start gap-2 px-1 text-[12.5px] text-muted">
              <BellRing className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                {rich('To hear about finished phases while Anemo is in the background, turn on desktop notifications in <a>Settings → Notifications</a>.', {
                  a: (c) => <Link to="/settings/notifications" className="font-medium text-accent hover:underline">{c}</Link>,
                })}
              </span>
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
