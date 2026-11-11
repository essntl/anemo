/**
 * The focus timer on this device: its saved state (timer.ts) plus what happens around
 * it (sounds, Island alerts, desktop notifications, recording sessions).
 *
 * The state is kept in this browser's storage, so a reload, a closed tab or a phone
 * that put the page to sleep picks up exactly where it was, offline too. It is also
 * shared through the server with every other Anemo tab and the browser extension
 * (timerSync.ts): each change made here is sent there, and changes made elsewhere are
 * taken. Settings (lengths, sounds, …) come from the server (Settings → Focus);
 * <TimerEngine> copies them in.
 *
 * `timerActions` are plain functions, so the Focus page, the Home widget, the Island,
 * the command palette and agent requests all drive the same timer.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { api } from '@/api/client'
import { showDesktopNotification } from '@/features/notifications/desktop'
import { islandAlert } from '@/features/island/alerts'
import { msg, plural, t } from '@/lib/i18n'
import { enqueueSession } from './outbox'
import { type Chime, playSound } from './sounds'
import { bindTimer, pushTimer } from './timerSync'
import * as timer from './timer'
import { DEFAULT_SETTINGS, type Phase, type TimerSettings, type TimerState, type Transition } from './timer'

export interface FocusPrefs extends TimerSettings {
  chime: Chime
  chimeVolume: number
  titleCountdown: boolean
}

export const DEFAULT_PREFS: FocusPrefs = { ...DEFAULT_SETTINGS, chime: 'bell', chimeVolume: 0.6, titleCountdown: true }

interface TimerStore {
  timer: TimerState
  prefs: FocusPrefs
  /** The last thing worth announcing to screen readers ("Break time"). */
  announcement: string
}

export const useTimerStore = create<TimerStore>()(
  persist(
    () => ({ timer: timer.initialState(DEFAULT_SETTINGS), prefs: DEFAULT_PREFS, announcement: '' }),
    {
      name: 'anemo-timer',
      version: 1,
      partialize: (s) => ({ timer: s.timer, prefs: s.prefs }),
    },
  ),
)

/** The current time, updated by <TimerEngine> once a second while the timer runs. */
export const useClock = create<{ now: number }>(() => ({ now: Date.now() }))

/** Opens a page of the app (set by <TimerEngine>, which can navigate). */
let openPage: (path: string) => void = (path) => window.location.assign(path)
export function setPageOpener(fn: (path: string) => void): void {
  openPage = fn
}

const NOTICE: Record<Phase, (p: FocusPrefs) => { title: string; body: string }> = {
  focus: (p) => ({ title: t('Break time'), body: plural(p.shortBreakMinutes, 'Session complete. Enjoy {n} minutes off.', 'Session complete. Enjoy {n} minutes off.') }),
  short_break: (p) => ({ title: t('Back to focus'), body: plural(p.focusMinutes, '{n} minutes on the clock.', '{n} minutes on the clock.') }),
  long_break: (p) => ({ title: t('Back to focus'), body: plural(p.focusMinutes, '{n} minutes on the clock.', '{n} minutes on the clock.') }),
}

function afterFinished(finished: Phase, next: TimerState, prefs: FocusPrefs): { title: string; body: string } {
  const notice =
    finished === 'focus' && next.phase === 'long_break'
      ? { title: t('Long break'), body: plural(prefs.longBreakMinutes, 'Cycle complete. Enjoy {n} minutes off.', 'Cycle complete. Enjoy {n} minutes off.') }
      : NOTICE[finished](prefs)
  playSound('chime', prefs.chime, prefs.chimeVolume)
  islandAlert({
    title: notice.title,
    body: notice.body,
    icon: finished === 'focus' ? 'coffee' : 'timer',
    tone: finished === 'focus' ? (next.phase === 'long_break' ? 'info' : 'success') : 'accent',
    duration: 4500,
    link: '/focus',
  })
  // Only shown while the tab is in the background, and only if turned on (Settings → Notifications).
  showDesktopNotification({ id: `focus-${next.sessionId}`, title: notice.title, body: notice.body }, () => openPage('/focus'))
  useTimerStore.setState({ announcement: `${notice.title}. ${notice.body}` })
  return notice
}

/** Apply a step of the timer: save the new state, record a session, react to a finished phase. */
function apply(step: (t: TimerState, prefs: FocusPrefs, now: number) => Transition | TimerState): Transition {
  const { timer: t, prefs } = useTimerStore.getState()
  const now = Date.now()
  const out = step(t, prefs, now)
  const result: Transition = 'state' in out ? out : { state: out, session: null, finished: null }
  if (result.state !== t) useTimerStore.setState({ timer: result.state })
  useClock.setState({ now })
  if (result.session) enqueueSession(result.session)
  const notice = result.finished ? afterFinished(result.finished, result.state, prefs) : null
  if (result.state !== t) {
    // Kept in the Notifications list too, if the user asked for that (the server checks);
    // only by the tab whose change counted, so another device finishing the same phase
    // doesn't add it twice.
    pushTimer(notice ? () => void api.POST('/api/focus/phase-ended', { body: notice }).catch(() => undefined) : undefined)
  }
  return result
}

/** A change made here outside `apply` (the task, the length): saved and shared. */
function change(patch: (t: TimerState) => TimerState) {
  const before = useTimerStore.getState().timer
  const after = patch(before)
  if (after === before) return
  useTimerStore.setState({ timer: after })
  pushTimer()
}

function announce(text: string) {
  useTimerStore.setState({ announcement: text })
}

const STARTED: Record<Phase, string> = { focus: msg('Focus started'), short_break: msg('Short break started'), long_break: msg('Long break started') }
const SKIPPED: Record<Phase, string> = { focus: msg('Skipped to focus'), short_break: msg('Skipped to short break'), long_break: msg('Skipped to long break') }

export const timerActions = {
  start() {
    apply((t, _p, now) => timer.start(t, now))
    const { prefs, timer: state } = useTimerStore.getState()
    playSound('start', prefs.chime, prefs.chimeVolume)
    announce(t(STARTED[state.phase]))
  },
  pause() {
    apply((t, _p, now) => timer.pause(t, now))
    announce(t('Timer paused'))
  },
  toggle() {
    if (useTimerStore.getState().timer.status === 'running') timerActions.pause()
    else timerActions.start()
  },
  reset() {
    apply((t, p, now) => timer.reset(t, p, now))
    const { prefs } = useTimerStore.getState()
    playSound('reset', prefs.chime, prefs.chimeVolume)
    announce(t('Timer reset'))
  },
  skip() {
    const { state } = apply((t, p, now) => timer.skip(t, p, now))
    announce(t(SKIPPED[state.phase]))
  },
  addMinute() {
    apply((t, _p, now) => timer.addMinutes(t, 1, now))
  },
  choosePhase(phase: Phase) {
    apply((t, p, now) => timer.choosePhase(t, phase, p, now))
  },
  /** Link the timer to an Anemo task (null: no task). */
  setTask(taskId: string | null) {
    change((t) => (t.taskId === taskId ? t : { ...t, taskId }))
  },
  /** Start a focus phase for this task, as the "Focus on this" buttons do. */
  focusOn(taskId: string | null, minutes?: number) {
    const { timer: t } = useTimerStore.getState()
    if (t.phase !== 'focus' || t.status === 'idle') timerActions.choosePhase('focus')
    timerActions.setTask(taskId)
    if (minutes) change((t) => (t.status === 'idle' ? { ...t, duration: minutes * 60_000 } : t))
    if (useTimerStore.getState().timer.status !== 'running') timerActions.start()
  },
  /** Finish the phase if its time is up (called by the engine's clock). */
  completeIfDue() {
    const end = timer.endsAt(useTimerStore.getState().timer)
    if (end !== null && Date.now() >= end) apply((t, p, now) => timer.complete(t, p, now))
  },
  /** New settings from the server. An idle timer takes the new lengths at once. */
  setPrefs(prefs: FocusPrefs) {
    useTimerStore.setState({ prefs })
    change((t) => timer.applySettings(t, prefs))
  },
}

// The shared state from the server replaces this tab's copy as it is (no sounds: the
// change happened elsewhere).
bindTimer(
  () => useTimerStore.getState().timer,
  (t) => {
    useTimerStore.setState({ timer: t })
    useClock.setState({ now: Date.now() })
  },
)

/** Everything a timer display needs, recomputed once a second while it runs. */
export function useTimer() {
  const t = useTimerStore((s) => s.timer)
  const prefs = useTimerStore((s) => s.prefs)
  const now = useClock((s) => s.now)
  return {
    ...t,
    prefs,
    remaining: timer.remaining(t, now),
    progress: timer.progress(t, now),
    active: timer.isActive(t),
    cycleIndex: timer.cycleIndex(t, prefs),
    running: t.status === 'running',
  }
}
