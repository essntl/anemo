import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DelayedLoading, LOADING_DELAY_MS } from './DelayedLoading'

describe('DelayedLoading', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('says nothing for a short load, then "Loading…"', () => {
    render(<DelayedLoading />)
    expect(screen.queryByText('Loading…')).toBeNull()
    act(() => vi.advanceTimersByTime(LOADING_DELAY_MS))
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })
})
