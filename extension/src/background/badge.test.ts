import { describe, expect, it } from 'vitest'
import { badgeFor } from './badge'

describe('badgeFor', () => {
  it('shows focus minutes first, then research, then approvals', () => {
    expect(badgeFor({ focusMinutes: 12.2, research: true, approvals: 2 }).text).toBe('13m')
    expect(badgeFor({ focusMinutes: null, research: true, approvals: 2 }).text).toBe('●')
    expect(badgeFor({ focusMinutes: null, research: false, approvals: 2 }).text).toBe('2')
    expect(badgeFor({ focusMinutes: null, research: false, approvals: 12 }).text).toBe('9+')
    expect(badgeFor({ focusMinutes: null, research: false, approvals: 0 }).text).toBe('')
  })
})
