import { describe, expect, it } from 'vitest'
import { durationMs, firstTextMs, type RunTiming, waitedMs, withWaiting, workedUntilWaitingMs } from './timing'

const at = (s: number) => new Date(Date.UTC(2026, 10, 20, 12, 0, s)).toISOString()
const timing = (over: Partial<RunTiming> = {}): RunTiming => ({
  started_at: at(0),
  finished_at: null,
  outcome: null,
  first_text_at: null,
  waiting_ms: 0,
  waiting_since: null,
  tool_calls: 0,
  ...over,
})

describe('answer timing', () => {
  it('is the time from start to end, without the time spent waiting for you', () => {
    const done = timing({ finished_at: at(50), waiting_ms: 9_000, first_text_at: at(2), outcome: 'done' })
    expect(durationMs(done)).toBe(41_000)
    expect(firstTextMs(done)).toBe(2_000)
    expect(durationMs(timing())).toBeNull()
    expect(firstTextMs(timing())).toBeNull()
  })

  it('stands still while it waits for you', () => {
    const waiting = timing({ waiting_ms: 3_000, waiting_since: at(20) })
    expect(workedUntilWaitingMs(waiting)).toBe(17_000)
    expect(waitedMs(waiting, Date.parse(at(30)))).toBe(13_000)
    expect(workedUntilWaitingMs(timing())).toBe(0)
  })

  it('takes the newest waiting time from the live stream', () => {
    const loaded = timing({ waiting_since: at(20) })
    expect(withWaiting(loaded, { waiting_ms: 5_000, waiting_since: null })).toMatchObject({ waiting_ms: 5_000, waiting_since: null })
    expect(withWaiting(loaded, null)).toBe(loaded)
  })
})
