/**
 * Focus: the timer in full. A large dial, the phase switch, +1 min, the task this
 * focus is for, what you focused on today and the timer's settings.
 * Space starts and pauses, R resets, S skips, + adds a minute.
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { BellRing, ChevronDown, Clock, Flame, Plus, Settings2, Timer } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Segmented } from '@/components/ui/Segmented'
import { useHotkey } from '@/hooks/useHotkey'
import { cn } from '@/lib/cn'
import { desktopEnabled } from '@/features/notifications/desktop'
import { useTasks } from '@/features/tasks/api'
import { formatMinutes, useTodayFocus } from './api'
import { TaskPicker } from './components/TaskPicker'
import { TimerDial } from './components/TimerDial'
import { TimerSettingsForm } from './components/TimerSettingsForm'
import { PHASE_LABEL, type Phase } from './timer'
import { timerActions, useTimer } from './timerStore'

function Kbd({ children }: { children: string }) {
  return <kbd className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10.5px] text-muted">{children}</kbd>
}

function Today() {
  const today = useTodayFocus()
  const tasks = useTasks()
  const titles = useMemo(() => new Map((tasks.data ?? []).map((t) => [t.id, t.title])), [tasks.data])
  const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return (
    <div className="px-4 pb-4 pt-3 md:px-5">
      <div className="flex items-center justify-between text-[11.5px] font-semibold uppercase tracking-wider text-muted">
        <span className="flex items-center gap-1.5"><Flame className="h-4 w-4" /> Today</span>
        <span className="text-[13px] normal-case tracking-normal text-text tabular-nums" data-testid="focus-today">
          {formatMinutes(today.minutes)}
        </span>
      </div>
      {today.sessions.length === 0 && !today.waiting ? (
        <p className="pt-2 text-[13px] text-muted">No sessions yet.</p>
      ) : (
        <ul className="mt-1 max-h-48 overflow-y-auto">
          {today.sessions.map((s) => (
            <li key={s.id} className="flex items-center gap-2.5 py-1.5 text-[13px]">
              <Clock className="h-3.5 w-3.5 shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate">{(s.task_id && titles.get(s.task_id)) || 'Focus session'}</span>
              <span className="shrink-0 text-muted tabular-nums">
                {time(s.started_at)} · {s.minutes}m{!s.completed && ' · cut short'}
              </span>
            </li>
          ))}
          {today.waiting > 0 && (
            <li className="py-1.5 text-[12.5px] text-muted">
              {today.waiting === 1 ? 'One session is' : `${today.waiting} sessions are`} waiting to be saved (offline).
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

export function FocusPage() {
  const t = useTimer()
  const [showSettings, setShowSettings] = useState(false)
  useHotkey((e) => e.key === ' ', () => timerActions.toggle())
  useHotkey((e) => e.key.toLowerCase() === 'r', () => timerActions.reset())
  useHotkey((e) => e.key.toLowerCase() === 's', () => timerActions.skip())
  useHotkey((e) => e.key === '+' || e.key === '=', () => timerActions.addMinute())

  return (
    <div className="mx-auto max-w-5xl p-4 md:p-8 md:pt-14">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Timer className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold">Focus</h1>
          <p className="truncate text-[13px] text-muted">Work in focused stretches, rest on purpose.</p>
        </div>
        <Link to="/stats" className="shrink-0 text-[13px] font-medium text-accent hover:underline">Stats</Link>
      </div>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card className="flex flex-col items-center px-4 py-6">
          <Segmented<Phase>
            label="Timer phase"
            className="mb-6"
            value={t.phase}
            onChange={(p) => p !== t.phase && timerActions.choosePhase(p)}
            options={(['focus', 'short_break', 'long_break'] as const).map((p) => ({ value: p, label: PHASE_LABEL[p] }))}
          />
          <TimerDial />
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={timerActions.addMinute}>1 min</Button>
            <TaskPicker />
          </div>
          <div className="mt-4 hidden flex-wrap items-center justify-center gap-x-3.5 gap-y-1 text-[11.5px] text-muted md:flex">
            <span><Kbd>Space</Kbd> start / pause</span>
            <span><Kbd>R</Kbd> reset</span>
            <span><Kbd>S</Kbd> skip</span>
            <span><Kbd>+</Kbd> add a minute</span>
          </div>
        </Card>

        <div className="flex flex-col gap-4">
          <Card><Today /></Card>
          <Card>
            <button type="button" aria-expanded={showSettings} onClick={() => setShowSettings((x) => !x)}
              className="flex w-full items-center gap-2 px-4 py-3.5 text-left md:px-5">
              <Settings2 className="h-4 w-4 text-muted" />
              <span className="flex-1 text-[14px] font-semibold">Timer settings</span>
              <span className="text-[12px] text-muted tabular-nums">{t.prefs.focusMinutes} / {t.prefs.shortBreakMinutes} / {t.prefs.longBreakMinutes}</span>
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
                To hear about finished phases while Anemo is in the background, turn on desktop notifications in{' '}
                <Link to="/settings/notifications" className="font-medium text-accent hover:underline">Settings → Notifications</Link>.
              </span>
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
