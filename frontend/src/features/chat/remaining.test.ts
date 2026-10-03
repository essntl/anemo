import { describe, expect, it } from 'vitest'
import { formatRemaining } from './remaining'

describe('time left of a temporary chat', () => {
  it('counts down like a clock in the chat', () => {
    expect(formatRemaining(300_000, 'clock')).toBe('5:00')
    expect(formatRemaining(272_400, 'clock')).toBe('4:33') // a started second still counts
    expect(formatRemaining(9_000, 'clock')).toBe('0:09')
    expect(formatRemaining(-5_000, 'clock')).toBe('0:00')
  })

  it('is short in the sidebar', () => {
    expect(formatRemaining(272_000, 'short')).toBe('5m')
    expect(formatRemaining(61_000, 'short')).toBe('2m')
    expect(formatRemaining(30_000, 'short')).toBe('<1m')
  })
})
