import { afterEach, describe, expect, it, vi } from 'vitest'
import { noteServerTime, serverNow } from './serverClock'

const answer = (serverMs: number | string | null) =>
  new Response(null, { headers: serverMs === null ? {} : { 'X-Server-Time': String(serverMs) } })

describe('the server clock', () => {
  afterEach(() => {
    vi.useRealTimers()
    noteServerTime(answer(Date.now()))
  })

  it('follows the server, however far off the browser clock is', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    // The browser is ten minutes behind the server.
    noteServerTime(answer(1_000_000 + 600_000))
    expect(serverNow()).toBe(1_600_000)
    vi.advanceTimersByTime(5_000)
    expect(serverNow()).toBe(1_605_000)
  })

  it('takes the server time as the middle of the round trip', () => {
    // Sent at 1000, back at 1400: the server answered at about 1200 of the browser's time.
    noteServerTime(answer(51_200), 1_000, 1_400)
    vi.useFakeTimers()
    vi.setSystemTime(2_000)
    expect(serverNow()).toBe(52_000)
  })

  it('ignores answers without the server time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    noteServerTime(answer(70_000))
    noteServerTime(answer(null))
    noteServerTime(answer('soon'))
    expect(serverNow()).toBe(70_000)
  })
})
