import { describe, expect, it } from 'vitest'
import {
  addMinutes,
  applySettings,
  complete,
  cycleIndex,
  DEFAULT_SETTINGS,
  elapsed,
  endsAt,
  formatClock,
  initialState,
  isActive,
  pause,
  progress,
  remaining,
  reset,
  skip,
  start,
  type TimerState,
  choosePhase,
} from './timer'

const MIN = 60_000
const T0 = Date.UTC(2026, 9, 5, 9, 0, 0)
const s = DEFAULT_SETTINGS

function running(at = T0): TimerState {
  return start(initialState(s), at)
}

describe('timer maths', () => {
  it('works out the remaining time from the clock, not from ticks', () => {
    const t = running()
    expect(remaining(t, T0)).toBe(25 * MIN)
    // Ten minutes in a background tab: no ticks needed.
    expect(remaining(t, T0 + 10 * MIN)).toBe(15 * MIN)
    expect(remaining(t, T0 + 10 * MIN + 1)).toBe(15 * MIN - 1)
    expect(progress(t, T0 + 12.5 * MIN)).toBeCloseTo(0.5)
    expect(remaining(t, T0 + 99 * MIN)).toBe(0)
    expect(endsAt(t)).toBe(T0 + 25 * MIN)
  })

  it('survives a reload: the saved state gives the same answer', () => {
    const t = running()
    const reloaded = JSON.parse(JSON.stringify(t)) as TimerState
    expect(remaining(reloaded, T0 + 7 * MIN)).toBe(remaining(t, T0 + 7 * MIN))
  })

  it('does not count paused time', () => {
    let t = running()
    t = pause(t, T0 + 5 * MIN)
    expect(t.status).toBe('paused')
    expect(remaining(t, T0 + 60 * MIN)).toBe(20 * MIN)
    t = start(t, T0 + 60 * MIN)
    expect(remaining(t, T0 + 62 * MIN)).toBe(18 * MIN)
    expect(t.phaseStartedAt).toBe(T0) // the session still starts at the first start
    expect(endsAt(t)).toBe(T0 + 80 * MIN)
  })

  it('+1 min lengthens the phase, and never leaves less than a minute', () => {
    const t = addMinutes(running(), 1, T0)
    expect(remaining(t, T0)).toBe(26 * MIN)
    const late = addMinutes(running(), -30, T0 + 20 * MIN)
    expect(remaining(late, T0 + 20 * MIN)).toBe(MIN)
  })

  it('finishes a focus phase into a short break, recording the session', () => {
    const t = { ...running(), taskId: 'task-1' }
    expect(complete(t, s, T0 + 24 * MIN).finished).toBeNull() // not yet
    const { state, session, finished } = complete(t, s, T0 + 25 * MIN)
    expect(finished).toBe('focus')
    expect(session).toEqual({
      clientId: t.sessionId,
      phase: 'focus',
      startedAt: T0,
      endedAt: T0 + 25 * MIN,
      minutes: 25,
      completed: true,
      taskId: 'task-1',
    })
    expect(state.phase).toBe('short_break')
    expect(state.round).toBe(1)
    expect(state.status).toBe('running') // auto-start breaks is on by default
    expect(state.sessionId).not.toBe(t.sessionId)
    expect(state.taskId).toBe('task-1')
  })

  it('finishes a phase that ended while the app was closed at its real end time', () => {
    const t = running()
    const later = T0 + 3 * 60 * MIN
    const { state, session } = complete(t, { ...s, autoStartBreaks: true }, later)
    expect(session?.endedAt).toBe(T0 + 25 * MIN)
    // The break that starts automatically begins now, not hours ago.
    expect(remaining(state, later)).toBe(5 * MIN)
  })

  it('leaves the next phase waiting when auto-start is off', () => {
    const { state } = complete(running(), { ...s, autoStartBreaks: false }, T0 + 25 * MIN)
    expect(state.status).toBe('idle')
    expect(remaining(state, T0 + 99 * MIN)).toBe(5 * MIN)
  })

  it('takes a long break after the set number of rounds, then starts a new cycle', () => {
    const settings = { ...s, roundsBeforeLongBreak: 2, autoStartFocus: true }
    let t = running()
    let now = T0
    const phases: string[] = []
    for (let i = 0; i < 4; i++) {
      now = endsAt(t)!
      t = complete(t, settings, now).state
      phases.push(`${t.phase}:${t.round}:${cycleIndex(t, settings)}`)
    }
    expect(phases).toEqual(['short_break:1:1', 'focus:1:1', 'long_break:2:0', 'focus:0:0'])
  })

  it('records a focus phase cut short (skip or reset) with the whole minutes focused', () => {
    const t = running()
    const skipped = skip(t, s, T0 + 7.5 * MIN)
    expect(skipped.session).toMatchObject({ minutes: 7, completed: false, endedAt: T0 + 7.5 * MIN })
    expect(skipped.state.phase).toBe('short_break')
    expect(skipped.state.status).toBe('running')
    expect(skipped.finished).toBeNull()

    const tooShort = reset(t, s, T0 + 50_000)
    expect(tooShort.session).toBeNull()
    expect(tooShort.state).toMatchObject({ phase: 'focus', status: 'idle', round: 0, duration: 25 * MIN })

    // Breaks are never recorded.
    const onBreak = start(choosePhase(initialState(s), 'short_break', s, T0).state, T0)
    expect(skip(onBreak, s, T0 + 4 * MIN).session).toBeNull()
  })

  it('applies new lengths to an idle timer only', () => {
    const longer = { ...s, focusMinutes: 50 }
    expect(applySettings(initialState(s), longer).duration).toBe(50 * MIN)
    const t = running()
    expect(applySettings(t, longer)).toBe(t)
  })

  it('knows when there is something to show', () => {
    expect(isActive(initialState(s))).toBe(false)
    expect(isActive(running())).toBe(true)
    expect(isActive(pause(running(), T0 + MIN))).toBe(true)
    expect(elapsed(initialState(s), T0)).toBe(0)
  })

  it('formats the clock, rounding up', () => {
    expect(formatClock(25 * MIN)).toBe('25:00')
    expect(formatClock(25 * MIN - 1)).toBe('25:00')
    expect(formatClock(61_000)).toBe('1:01')
    expect(formatClock(999)).toBe('0:01')
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(90 * MIN)).toBe('1:30:00')
  })
})
