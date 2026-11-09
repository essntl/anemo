/**
 * The focus timer, shared: one running state on the server that every Anemo tab (on
 * every device) and the browser extension follow.
 *
 * This tab still runs the timer from its own copy (timerStore, saved on the device), so
 * it keeps working offline. Each change is sent to the server with the version it was
 * made on. When someone else changed the timer first, the server refuses (409 with the
 * current state) and this tab takes the newer state: the change made elsewhere wins.
 * Changes made elsewhere arrive as `focus.timer` events (and are fetched when the app
 * opens, comes to the front or gets back online).
 *
 * A change that couldn't be sent (offline) waits (`dirty`) and is sent later, unless the
 * timer was changed elsewhere in the meantime.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { api, ApiError, unwrap } from '@/api/client'
import type { components } from '@/api/schema'
import { isActive, type TimerState } from './timer'

export type TimerWire = components['schemas']['FocusTimerState']
export type TimerOut = components['schemas']['FocusTimerOut']

export function toWire(t: TimerState): TimerWire {
  return {
    phase: t.phase,
    status: t.status,
    phase_started_at: t.phaseStartedAt,
    started_at: t.startedAt,
    paused_at: t.pausedAt,
    accumulated: Math.round(t.accumulated),
    duration: Math.round(t.duration),
    round: t.round,
    task_id: t.taskId,
    session_id: t.sessionId,
  }
}

export function fromWire(w: TimerWire): TimerState {
  return {
    phase: w.phase,
    status: w.status,
    phaseStartedAt: w.phase_started_at ?? null,
    startedAt: w.started_at ?? null,
    pausedAt: w.paused_at ?? null,
    accumulated: w.accumulated ?? 0,
    duration: w.duration,
    round: w.round ?? 0,
    taskId: w.task_id ?? null,
    sessionId: w.session_id,
  }
}

interface SyncState {
  /** The server's version this tab's state is based on (0: none yet). */
  version: number
  /** A change made here that the server hasn't taken yet. */
  dirty: boolean
}

export const useTimerSync = create<SyncState>()(persist((): SyncState => ({ version: 0, dirty: false }), { name: 'anemo-timer-sync' }))

/** How the sync reads and replaces the timer (set by timerStore, which owns it). */
let readTimer: () => TimerState = () => {
  throw new Error('timer not bound')
}
let writeTimer: (t: TimerState) => void = () => undefined
export function bindTimer(read: () => TimerState, write: (t: TimerState) => void): void {
  readTimer = read
  writeTimer = write
}

function adopt(out: TimerOut): void {
  if (!out.state) return
  writeTimer(fromWire(out.state))
  useTimerSync.setState({ version: out.version, dirty: false })
}

/** A state from the server (fetched, or a `focus.timer` event): taken if it is newer. */
export function receive(out: TimerOut): void {
  const { version, dirty } = useTimerSync.getState()
  if (!out.state) {
    // Nothing on the server yet: this tab's timer becomes the shared one, if it is in use.
    if (version === 0 && isActive(readTimer())) pushTimer()
    return
  }
  if (out.version > version) adopt(out)
  else if (out.version === version && dirty) pushTimer()
}

let pushing: Promise<void> | null = null
let again = false
let waiting: (() => void)[] = []

async function sendOnce(): Promise<void> {
  const accepted = waiting
  waiting = []
  const { version } = useTimerSync.getState()
  try {
    const out = unwrap(await api.PUT('/api/focus/timer', { body: { state: toWire(readTimer()), base_version: version, source: 'tab' } }))
    // A newer change made here while this one was on its way is sent next.
    useTimerSync.setState({ version: out.version, dirty: again })
    accepted.forEach((fn) => fn())
  } catch (err) {
    if (err instanceof ApiError && err.code === 'timer_conflict') {
      const current = (err.details as { current?: TimerOut } | undefined)?.current
      if (current) adopt(current)
      again = false
      return
    }
    // Offline or the server is down: stays dirty, sent again later.
  }
}

/**
 * Send this tab's timer to the server (after a change made here). `onAccepted` runs if
 * the server takes this change (not when the timer was changed elsewhere first).
 */
export function pushTimer(onAccepted?: () => void): void {
  useTimerSync.setState({ dirty: true })
  if (onAccepted) waiting.push(onAccepted)
  if (pushing) {
    again = true
    return
  }
  pushing = sendOnce().finally(() => {
    pushing = null
    if (again) {
      again = false
      pushTimer()
    }
  })
}

/** Fetch the shared state (the app opened, came to the front, or is back online). */
export async function pullTimer(): Promise<void> {
  try {
    receive(unwrap(await api.GET('/api/focus/timer')))
  } catch {
    // Offline: carry on with this tab's copy.
  }
}

/** For tests. */
export async function settled(): Promise<void> {
  while (pushing) await pushing
}
