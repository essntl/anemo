import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { noteServerTime, resetServerClock, serverNow } from './serverClock'

const answer = (serverMs: number | string | null) =>
  new Response(null, { headers: serverMs === null ? {} : { 'X-Server-Time': String(serverMs) } })

describe('the server clock', () => {
  beforeEach(() => {
    resetServerClock()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetServerClock()
  })

  it('follows the server, however far off the browser clock is', () => {
    vi.setSystemTime(1_000_000)
    // The browser is ten minutes behind the server.
    noteServerTime(answer(1_000_000 + 600_000))
    expect(serverNow()).toBe(1_600_000)
    vi.advanceTimersByTime(5_000)
    expect(serverNow()).toBe(1_605_000)
  })

  it('takes the server time as of when the answer arrived', () => {
    // The server worked 3.9 s and stamped its time as the answer went out (0.1 s back):
    // the stamp belongs to the arrival, not to the middle of the trip.
    noteServerTime(answer(54_900), 1_000, 5_000)
    vi.setSystemTime(6_000)
    expect(serverNow()).toBe(55_900)
  })

  it('keeps the sample with the shortest round trip', () => {
    noteServerTime(answer(60_000), 9_950, 10_000) // 50 ms there and back: offset 50 s
    // A slow answer (a provider test: 8 s of work) arrives later with an older stamp.
    noteServerTime(answer(69_900), 12_000, 20_100)
    vi.setSystemTime(30_000)
    expect(serverNow()).toBe(80_000) // still the fast sample's offset
    // A faster one replaces it.
    noteServerTime(answer(81_020), 29_990, 30_000)
    expect(serverNow()).toBe(81_020)
  })

  it('takes a newer sample once the best one is old', () => {
    const later = 10_000 + 11 * 60_000
    noteServerTime(answer(60_000), 9_990, 10_000)
    noteServerTime(answer(later + 5_000), later - 500, later)
    vi.setSystemTime(later)
    expect(serverNow()).toBe(later + 5_000)
  })

  it('ignores answers without the server time', () => {
    vi.setSystemTime(10_000)
    noteServerTime(answer(70_000))
    noteServerTime(answer(null))
    noteServerTime(answer('soon'))
    expect(serverNow()).toBe(70_000)
  })
})
