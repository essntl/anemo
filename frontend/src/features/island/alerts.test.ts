import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dismissIslandAlert, isQuiet, islandAlert, setQuiet, useIslandAlerts } from './alerts'

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

  it('while quiet, holds what can wait and shows the rest', () => {
    setQuiet(true)
    expect(isQuiet()).toBe(true)
    islandAlert({ title: 'The agent finished', deferrable: true })
    expect(useIslandAlerts.getState().current).toBeNull()
    islandAlert({ title: 'Approval needed' })
    expect(useIslandAlerts.getState().current?.title).toBe('Approval needed')
    dismissIslandAlert()
    // The break: the one that waited is shown as it was.
    setQuiet(false)
    expect(useIslandAlerts.getState().current?.title).toBe('The agent finished')
  })

  it('after a quiet stretch, several held alerts become one line', () => {
    setQuiet(true)
    islandAlert({ title: 'The agent finished', deferrable: true })
    islandAlert({ title: 'Low Tide', key: 'now-playing', deferrable: true })
    islandAlert({ title: 'Slow Morning', key: 'now-playing', deferrable: true })
    setQuiet(false)
    const shown = useIslandAlerts.getState().current
    expect(shown?.title).toBe('2 things happened while you focused')
    expect(shown?.body).toBe('The agent finished · Slow Morning')
    expect(shown?.link).toBe('/notifications')
  })

  it('can be dismissed', () => {
    islandAlert({ title: 'One' })
    islandAlert({ title: 'Two' })
    dismissIslandAlert()
    expect(useIslandAlerts.getState().current?.title).toBe('Two')
  })
})
