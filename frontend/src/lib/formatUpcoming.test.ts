import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatUpcoming } from './format'

/* frontend-13: days are calendar days in the user's own time zone. */
describe('days in the local time zone', () => {
  beforeEach(() => {
    vi.stubEnv('TZ', 'Europe/Amsterdam')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('a time late on the day the clocks go back is still today', () => {
    // 25 October 2026 has 25 hours in Amsterdam.
    const now = new Date(2026, 9, 25, 10, 0)
    const late = new Date(2026, 9, 25, 23, 30).toISOString()
    expect(formatUpcoming(late, now)).toMatch(/^Today /)
    expect(formatUpcoming(new Date(2026, 9, 26, 0, 30).toISOString(), now)).toMatch(/^Tomorrow /)
  })
})
