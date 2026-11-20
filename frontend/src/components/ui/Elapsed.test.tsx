import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { noteServerTime } from '@/lib/serverClock'
import { Elapsed } from './Elapsed'

const SERVER_NOW = Date.UTC(2026, 10, 20, 12, 0, 0)
const serverAgo = (s: number) => new Date(SERVER_NOW - s * 1000).toISOString()
const serverTime = (ms: number) => new Response(null, { headers: { 'X-Server-Time': String(ms) } })

describe('Elapsed', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // The browser's clock is five minutes behind the server's.
    vi.setSystemTime(SERVER_NOW - 300_000)
    noteServerTime(serverTime(SERVER_NOW))
  })
  afterEach(() => {
    vi.useRealTimers()
    noteServerTime(serverTime(Date.now()))
  })

  it('counts from the server’s start, not from when the page opened', () => {
    // A reload in the middle of an answer that started 75 s ago (on the server's clock).
    render(<Elapsed since={serverAgo(75)} />)
    expect(screen.getByText('1 m 15 s')).toBeInTheDocument()
    act(() => void vi.advanceTimersByTime(1000))
    expect(screen.getByText('1 m 16 s')).toBeInTheDocument()
    act(() => void vi.advanceTimersByTime(3000))
    expect(screen.getByText('1 m 19 s')).toBeInTheDocument()
  })

  it('leaves out time that does not count', () => {
    render(<Elapsed since={serverAgo(75)} minusMs={70_000} />)
    expect(screen.getByText('5 s')).toBeInTheDocument()
  })

  it('stops its timer when it goes', () => {
    const { unmount } = render(<Elapsed since={serverAgo(1)} />)
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
