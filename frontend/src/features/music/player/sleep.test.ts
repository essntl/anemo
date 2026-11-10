import { describe, expect, it } from 'vitest'
import { stopAfter, useSleepTimer } from './sleep'

describe('stop after', () => {
  it('remembers what was chosen and when the music stops', () => {
    stopAfter(30, 1_000_000)
    expect(useSleepTimer.getState()).toEqual({ minutes: 30, until: 1_000_000 + 30 * 60_000 })
  })

  it('is switched off with null', () => {
    stopAfter(15)
    stopAfter(null)
    expect(useSleepTimer.getState()).toEqual({ minutes: null, until: null })
  })
})
