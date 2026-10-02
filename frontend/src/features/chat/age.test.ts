import { ageRange } from './age'

describe('ageRange', () => {
  const now = new Date(2026, 9, 10, 15, 30) // 10 Oct 2026, 15:30 local time
  const day = (d: number) => new Date(2026, 9, d).toISOString()

  it('uses whole calendar days, counted back from today', () => {
    expect(ageRange('today', now)).toEqual({ after: day(10) })
    expect(ageRange('yesterday', now)).toEqual({ after: day(9), before: day(10) })
    expect(ageRange('week', now)).toEqual({ after: day(4) })
    expect(ageRange('month', now)).toEqual({ after: new Date(2026, 8, 11).toISOString() })
    expect(ageRange('older', now)).toEqual({ before: new Date(2026, 8, 11).toISOString() })
  })

  it('has no limits for "any time"', () => {
    expect(ageRange('', now)).toEqual({})
  })
})
