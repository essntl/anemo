/**
 * The focus timer's rules, as pure functions of a saved state and the current time.
 *
 * The timer never counts ticks. It stores when the running stretch started
 * (`startedAt`) and how much of the phase had already run before that
 * (`accumulated`); the remaining time is worked out from the clock whenever it is
 * needed. So it stays exact in a background tab (where browsers slow timers down),
 * survives reloads (the state is saved on the device) and can finish a phase that
 * ended while the app was closed.
 */

export type Phase = 'focus' | 'short_break' | 'long_break'
export type TimerStatus = 'idle' | 'running' | 'paused'

export interface TimerState {
  phase: Phase
  status: TimerStatus
  /** When this phase was first started (the session's start), or null before that. */
  phaseStartedAt: number | null
  /** Epoch ms when the current running stretch began; null unless running. */
  startedAt: number | null
  /** Epoch ms when it was paused; null unless paused. */
  pausedAt: number | null
  /** Ms the phase ran before the current stretch (earlier stretches, before pauses). */
  accumulated: number
  /** Total ms of the phase (+1 min makes it longer). */
  duration: number
  /** Focus phases finished in the current cycle (resets after a long break). */
  round: number
  /** The Anemo task this focus is for. */
  taskId: string | null
  /** Identifies the current phase's session, so it is stored once on the server. */
  sessionId: string
}

export interface TimerSettings {
  focusMinutes: number
  shortBreakMinutes: number
  longBreakMinutes: number
  roundsBeforeLongBreak: number
  autoStartBreaks: boolean
  autoStartFocus: boolean
}

/** A focus phase worth keeping, ready to send to the server. */
export interface SessionRecord {
  clientId: string
  phase: Phase
  startedAt: number
  endedAt: number
  minutes: number
  completed: boolean
  taskId: string | null
}

export interface Transition {
  state: TimerState
  /** The focus session to record, when a focus phase ended with at least a minute in it. */
  session: SessionRecord | null
  /** The phase that just ended, when it ran to its end (for the chime and notices). */
  finished: Phase | null
}

const MINUTE = 60_000

export const DEFAULT_SETTINGS: TimerSettings = {
  focusMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  roundsBeforeLongBreak: 4,
  autoStartBreaks: true,
  autoStartFocus: false,
}

let counter = 0
/** A new session id (random enough to never repeat on one device). */
export function newSessionId(): string {
  counter += 1
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Math.random())
  return `${random}-${counter}`
}

export function phaseMs(phase: Phase, s: TimerSettings): number {
  const minutes = phase === 'focus' ? s.focusMinutes : phase === 'short_break' ? s.shortBreakMinutes : s.longBreakMinutes
  return minutes * MINUTE
}

export function initialState(s: TimerSettings = DEFAULT_SETTINGS): TimerState {
  return {
    phase: 'focus',
    status: 'idle',
    phaseStartedAt: null,
    startedAt: null,
    pausedAt: null,
    accumulated: 0,
    duration: phaseMs('focus', s),
    round: 0,
    taskId: null,
    sessionId: newSessionId(),
  }
}

/** Ms of the phase that have run (pauses excluded), never more than its length. */
export function elapsed(t: TimerState, now: number): number {
  const running = t.status === 'running' && t.startedAt !== null ? Math.max(0, now - t.startedAt) : 0
  return Math.min(t.duration, t.accumulated + running)
}

export function remaining(t: TimerState, now: number): number {
  return Math.max(0, t.duration - elapsed(t, now))
}

/** 0 at the start of the phase, 1 at its end. */
export function progress(t: TimerState, now: number): number {
  return t.duration > 0 ? Math.min(1, elapsed(t, now) / t.duration) : 0
}

/** When a running phase reaches its end; null unless running. */
export function endsAt(t: TimerState): number | null {
  return t.status === 'running' && t.startedAt !== null ? t.startedAt + (t.duration - t.accumulated) : null
}

/** Whether the timer has anything to show (the Island hides an untouched timer). */
export function isActive(t: TimerState): boolean {
  return t.status !== 'idle' || t.round > 0 || t.phase !== 'focus' || t.accumulated > 0
}

/** Which focus session of the cycle this is, from 0 (for the dots and "round 2/4"). */
export function cycleIndex(t: TimerState, s: TimerSettings): number {
  return t.round % Math.max(1, s.roundsBeforeLongBreak)
}

export function start(t: TimerState, now: number): TimerState {
  if (t.status === 'running') return t
  return { ...t, status: 'running', startedAt: now, pausedAt: null, phaseStartedAt: t.phaseStartedAt ?? now }
}

export function pause(t: TimerState, now: number): TimerState {
  if (t.status !== 'running') return t
  return { ...t, status: 'paused', accumulated: elapsed(t, now), startedAt: null, pausedAt: now }
}

export function toggle(t: TimerState, now: number): TimerState {
  return t.status === 'running' ? pause(t, now) : start(t, now)
}

/** +1 min (or any number of minutes) on the current phase. Never below a minute left. */
export function addMinutes(t: TimerState, minutes: number, now: number): TimerState {
  const duration = Math.max(elapsed(t, now) + MINUTE, t.duration + minutes * MINUTE)
  return { ...t, duration }
}

function nextPhase(t: TimerState, s: TimerSettings): { phase: Phase; round: number } {
  if (t.phase === 'focus') {
    const round = t.round + 1
    return { phase: round % Math.max(1, s.roundsBeforeLongBreak) === 0 ? 'long_break' : 'short_break', round }
  }
  return { phase: 'focus', round: t.phase === 'long_break' ? 0 : t.round }
}

/** The session for the phase that is ending, if it is a focus phase with a minute in it. */
function sessionFor(t: TimerState, endedAt: number, ran: number, completed: boolean): SessionRecord | null {
  if (t.phase !== 'focus') return null
  // A finished phase counts its full minutes; one cut short only the whole minutes focused.
  const minutes = completed ? Math.round(ran / MINUTE) : Math.floor(ran / MINUTE)
  if (minutes < 1) return null
  return {
    clientId: t.sessionId,
    phase: t.phase,
    startedAt: t.phaseStartedAt ?? endedAt - ran,
    endedAt,
    minutes,
    completed,
    taskId: t.taskId,
  }
}

/** A fresh phase, idle or already running from `now`. */
function enter(t: TimerState, phase: Phase, round: number, s: TimerSettings, run: boolean, now: number): TimerState {
  return {
    ...t,
    phase,
    round,
    status: run ? 'running' : 'idle',
    phaseStartedAt: run ? now : null,
    startedAt: run ? now : null,
    pausedAt: null,
    accumulated: 0,
    duration: phaseMs(phase, s),
    sessionId: newSessionId(),
  }
}

/**
 * The running phase reached its end (possibly while the app was closed: then the
 * session ends when the phase did, and an auto-started next phase begins now).
 */
export function complete(t: TimerState, s: TimerSettings, now: number): Transition {
  const end = endsAt(t)
  if (end === null || now < end) return { state: t, session: null, finished: null }
  const session = sessionFor(t, end, t.duration, true)
  const next = nextPhase(t, s)
  const auto = t.phase === 'focus' ? s.autoStartBreaks : s.autoStartFocus
  return { state: enter(t, next.phase, next.round, s, auto, now), session, finished: t.phase }
}

/** Jump to the next phase. A focus phase cut short still records the minutes focused. */
export function skip(t: TimerState, s: TimerSettings, now: number): Transition {
  const session = sessionFor(t, now, elapsed(t, now), false)
  const next = nextPhase(t, s)
  return { state: enter(t, next.phase, next.round, s, t.status === 'running', now), session, finished: null }
}

/** Back to the start of the cycle. A focus phase in progress records its minutes. */
export function reset(t: TimerState, s: TimerSettings, now: number): Transition {
  const session = sessionFor(t, now, elapsed(t, now), false)
  return { state: enter(t, 'focus', 0, s, false, now), session, finished: null }
}

/** Pick a phase by hand (the Focus / Short break / Long break switch). */
export function choosePhase(t: TimerState, phase: Phase, s: TimerSettings, now: number): Transition {
  if (phase === t.phase && t.status === 'idle') return { state: t, session: null, finished: null }
  const session = sessionFor(t, now, elapsed(t, now), false)
  return { state: enter(t, phase, t.round, s, false, now), session, finished: null }
}

/** New lengths apply at once to an idle timer; a phase in progress keeps its length. */
export function applySettings(t: TimerState, s: TimerSettings): TimerState {
  if (t.status !== 'idle' || t.accumulated > 0) return t
  const duration = phaseMs(t.phase, s)
  return duration === t.duration ? t : { ...t, duration }
}

/** "24:59", or "1:02:03" past an hour. Rounds up, so it shows 0:00 only at the very end. */
export function formatClock(ms: number): string {
  const total = Math.ceil(Math.max(0, ms) / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = String(total % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

export const PHASE_LABEL: Record<Phase, string> = {
  focus: 'Focus',
  short_break: 'Short break',
  long_break: 'Long break',
}

/** The phase's colour token (styles/tokens.css). */
export const PHASE_COLOR: Record<Phase, string> = {
  focus: 'var(--phase-focus)',
  short_break: 'var(--phase-short)',
  long_break: 'var(--phase-long)',
}
