import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dismissIslandAlert, islandAlert, useIslandAlerts } from './alerts'

describe('island alerts', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    while (useIslandAlerts.getState().current) dismissIslandAlert()
    vi.useRealTimers()
  })

  it('shows one at a time, each for its duration', () => {
    islandAlert({ title: 'Break time', duration: 1000 })
    islandAlert({ title: 'Added 12 tracks', duration: 1000 })
    expect(useIslandAlerts.getState().current?.title).toBe('Break time')
    vi.advanceTimersByTime(1000)
    expect(useIslandAlerts.getState().current?.title).toBe('Added 12 tracks')
    vi.advanceTimersByTime(1000)
    expect(useIslandAlerts.getState().current).toBeNull()
  })

  it('replaces an alert with the same key instead of queueing it', () => {
    islandAlert({ title: 'Shuffle on', key: 'mode' })
    islandAlert({ title: 'Something else' })
    islandAlert({ title: 'Shuffle off', key: 'mode' })
    expect(useIslandAlerts.getState().current?.title).toBe('Shuffle off')
    expect(useIslandAlerts.getState().queue.map((a) => a.title)).toEqual(['Something else'])
  })

  it('can be dismissed', () => {
    islandAlert({ title: 'One' })
    islandAlert({ title: 'Two' })
    dismissIslandAlert()
    expect(useIslandAlerts.getState().current?.title).toBe('Two')
  })
})
