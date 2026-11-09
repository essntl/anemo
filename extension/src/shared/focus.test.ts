import { describe, expect, it } from 'vitest'
import { blockingUntil, blockRules, focusMinutesLeft, fromWire, normalizeSite, phaseNotice, sitePatterns, steps, timer, toWire, type FocusMirror } from './focus'

const MIN = 60_000
const T0 = Date.UTC(2026, 10, 9, 9, 0, 0)
const s = timer.DEFAULT_SETTINGS

function mirror(state: FocusMirror['state']): FocusMirror {
  return { state, version: 1, settings: s, at: T0 }
}

describe('focus', () => {
  it('blocks only while a focus phase runs, until it ends', () => {
    const running = timer.start(timer.initialState(s), T0)
    expect(blockingUntil(mirror(running), T0 + MIN)).toBe(T0 + 25 * MIN)
    expect(focusMinutesLeft(mirror(running), T0 + 10 * MIN)).toBe(15)
    // Over (even if no one finished the phase yet), paused, a break, nothing at all.
    expect(blockingUntil(mirror(running), T0 + 25 * MIN)).toBeNull()
    expect(blockingUntil(mirror(timer.pause(running, T0 + MIN)), T0 + 2 * MIN)).toBeNull()
    const breakTime = timer.skip(running, s, T0 + MIN).state
    expect(breakTime.phase).toBe('short_break')
    expect(blockingUntil(mirror(breakTime), T0 + 2 * MIN)).toBeNull()
    expect(blockingUntil(null, T0)).toBeNull()
  })

  it('turns what you type into a site', () => {
    expect(normalizeSite('https://www.youtube.com/watch?v=x')).toBe('youtube.com')
    expect(normalizeSite(' Reddit.com ')).toBe('reddit.com')
    expect(normalizeSite('news.ycombinator.com')).toBe('news.ycombinator.com')
    expect(normalizeSite('not a site')).toBeNull()
    expect(normalizeSite('localhost')).toBeNull()
    expect(normalizeSite('ftp://example.com')).toBeNull()
    expect(sitePatterns('reddit.com')).toEqual(['*://reddit.com/*', '*://*.reddit.com/*'])
  })

  it('redirects a blocked page to the focus page with its address', () => {
    const [rule] = blockRules(['reddit.com'], 'chrome-extension://x/pages/blocked.html')
    expect(rule.condition).toEqual({ requestDomains: ['reddit.com'], regexFilter: '^.*$', resourceTypes: ['main_frame'] })
    expect(rule.action.redirect?.regexSubstitution).toBe('chrome-extension://x/pages/blocked.html#\\0')
  })

  it('starts focus as Anemo does: from a break or idle, for a task', () => {
    const idle = timer.initialState(s)
    const started = steps.startFocus('task-1')(idle, s, T0)
    const state = 'state' in started ? started.state : started
    expect(state).toMatchObject({ phase: 'focus', status: 'running', taskId: 'task-1', startedAt: T0 })
    const inBreak = timer.skip(timer.start(idle, T0), s, T0 + 2 * MIN)
    const fromBreak = steps.startFocus(undefined)(inBreak.state, s, T0 + 3 * MIN)
    expect('state' in fromBreak && fromBreak.state.phase).toBe('focus')
  })

  it('round-trips the wire format and words a finished phase', () => {
    const t = timer.start(timer.initialState(s), T0)
    expect(fromWire(toWire(t))).toEqual(t)
    const next = timer.complete(t, s, T0 + 25 * MIN).state
    expect(phaseNotice('focus', next, s)).toEqual({ title: 'Break time', body: 'Session complete. Enjoy 5 minutes off.' })
  })
})
