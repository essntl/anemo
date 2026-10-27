import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { useSettings } from '@/features/settings/api'
import { focusKey } from './api'
import { flushOutbox, onSessionsSent, useOutbox } from './outbox'
import * as timer from './timer'
import { setPageOpener, timerActions, useClock, useTimerStore } from './timerStore'

/**
 * Keeps the focus timer going while the app is open (mounted once, in
 * PersistentLayer). It renders only a hidden live region for screen readers.
 *
 *  - The clock wakes just after each displayed second changes, not several times a
 *    second; when the tab comes back to the front it catches up at once.
 *  - A phase whose time is up is finished here (also one that ended while the app
 *    was closed).
 *  - Settings → Focus is copied into the timer.
 *  - The tab title shows the countdown, if that is on.
 *  - Sessions waiting offline are sent when the connection is back.
 *  - Another tab changing the timer is picked up (they share this device's storage).
 */
export function TimerEngine() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const t = useTimerStore((s) => s.timer)
  const prefs = useTimerStore((s) => s.prefs)
  const announcement = useTimerStore((s) => s.announcement)
  const now = useClock((s) => s.now)
  const focus = useSettings().data?.focus

  useEffect(() => setPageOpener((path) => void navigate(path)), [navigate])

  // Settings from the server.
  useEffect(() => {
    if (!focus) return
    timerActions.setPrefs({
      focusMinutes: focus.focus_minutes,
      shortBreakMinutes: focus.short_break_minutes,
      longBreakMinutes: focus.long_break_minutes,
      roundsBeforeLongBreak: focus.rounds_before_long_break,
      autoStartBreaks: focus.auto_start_breaks,
      autoStartFocus: focus.auto_start_focus,
      chime: focus.chime,
      chimeVolume: focus.chime_volume,
      titleCountdown: focus.title_countdown,
    })
  }, [focus])

  // The clock.
  useEffect(() => {
    if (t.status !== 'running') return
    let id: ReturnType<typeof setTimeout>
    const tick = () => {
      const current = useTimerStore.getState().timer
      const n = Date.now()
      useClock.setState({ now: n })
      const end = timer.endsAt(current)
      if (end === null) return
      if (n >= end) {
        timerActions.completeIfDue()
        return // the new state (if running) starts a new loop
      }
      // Wake up just after the shown second changes.
      id = setTimeout(tick, ((end - n) % 1000 || 1000) + 15)
    }
    tick()
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      clearTimeout(id)
      tick()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearTimeout(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [t.status, t.startedAt, t.duration, t.accumulated])

  // Another tab of the app changed the timer.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'anemo-timer') void useTimerStore.persist.rehydrate()
      if (e.key === 'anemo-focus-outbox') void useOutbox.persist.rehydrate()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // Sessions recorded while offline.
  useEffect(() => {
    const refresh = () => {
      void qc.invalidateQueries({ queryKey: focusKey })
      void qc.invalidateQueries({ queryKey: ['stats'] })
    }
    const off = onSessionsSent(refresh)
    void flushOutbox()
    const retry = () => void flushOutbox()
    window.addEventListener('online', retry)
    const id = setInterval(() => useOutbox.getState().pending.length && retry(), 60_000)
    return () => {
      off()
      window.removeEventListener('online', retry)
      clearInterval(id)
    }
  }, [qc])

  // The countdown in the tab title.
  const base = useRef<string | null>(null)
  const clock = timer.formatClock(timer.remaining(t, now))
  useEffect(() => {
    if (base.current === null) base.current = document.title
    if (!prefs.titleCountdown || t.status === 'idle') {
      document.title = base.current
      return
    }
    const paused = t.status === 'paused' ? 'Paused · ' : ''
    document.title = `${paused}${clock} · ${timer.PHASE_LABEL[t.phase]} · ${base.current}`
  }, [clock, t.status, t.phase, prefs.titleCountdown])

  // Phase changes, read by screen readers (not every second).
  return (
    <div className="sr-only" role="status" aria-live="polite">
      {announcement}
    </div>
  )
}
