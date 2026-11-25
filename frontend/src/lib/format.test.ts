import { dayLabel, formatAgo, formatCost, formatCount, formatDateTime, formatDuration, formatWhen } from './format'

describe('formatters', () => {
  it('says how long ago a time was', () => {
    const now = new Date(2026, 9, 10, 9, 0)
    const ago = (seconds: number) => formatAgo(new Date(now.getTime() - seconds * 1000).toISOString(), now)
    expect(ago(10)).toBe('just now')
    expect(ago(5 * 60)).toMatch(/5 min/)
    expect(ago(3 * 3600)).toMatch(/3 hr/)
    expect(ago(86_400)).toBe('yesterday')
    expect(ago(3 * 86_400)).toMatch(/3 days/)
    expect(ago(3 * 31_557_600)).toMatch(/3 yr/)
    expect(formatDateTime(now.toISOString())).toMatch(/2026/)
  })

  it('names the day a date falls on', () => {
    const now = new Date(2026, 9, 10, 9, 0) // 10 Oct 2026, 09:00
    const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).toISOString()
    expect(dayLabel(at(2026, 9, 10, 0), now)).toBe('Today')
    expect(dayLabel(at(2026, 9, 9, 23), now)).toBe('Yesterday')
    expect(dayLabel(at(2026, 9, 8), now)).toBe('Past week')
    expect(dayLabel(at(2026, 9, 3, 0), now)).toBe('Past week')
    expect(dayLabel(at(2026, 9, 2, 23), now)).toMatch(/2/)
    expect(dayLabel(at(2026, 9, 2, 23), now)).not.toMatch(/2026/)
    expect(dayLabel(at(2025, 11, 31), now)).toMatch(/2025/)
  })

  it('formats durations', () => {
    expect(formatDuration(42)).toBe('42 s')
    expect(formatDuration(185)).toBe('3 min 5 s')
    expect(formatDuration(120)).toBe('2 min')
    expect(formatDuration(7300)).toBe('2 h 1 min')
  })

  it('formats how long an answer takes, live or done, in whole seconds', () => {
    const timer = (s: number) => formatDuration(s, { style: 'timer' })
    expect(timer(0)).toBe('0 s')
    expect(timer(42.9)).toBe('42 s')
    expect(timer(59.99)).toBe('59 s')
    expect(timer(60)).toBe('1 m 00 s')
    expect(timer(125)).toBe('2 m 05 s')
    expect(timer(3599)).toBe('59 m 59 s')
    expect(timer(3780)).toBe('1 h 03 m')
    expect(timer(-3)).toBe('0 s')
  })

  it('formats costs, keeping unknown apart from zero', () => {
    expect(formatCost(null)).toBe('unknown')
    expect(formatCost(0)).toBe('$0')
    expect(formatCost(0.00123)).toBe('$0.0012')
    expect(formatCost(1.5)).toBe('$1.50')
  })

  it('formats counts', () => {
    expect(formatCount(950)).toBe('950')
    expect(formatCount(1234)).toBe('1.2k')
    expect(formatCount(45_000)).toBe('45k')
    expect(formatCount(2_500_000)).toBe('2.5M')
  })

  it('formats times relative to today', () => {
    const now = new Date(2026, 8, 30, 15, 0)
    expect(formatWhen(new Date(2026, 8, 30, 9, 5).toISOString(), now)).not.toMatch(/Yesterday|Sep/)
    expect(formatWhen(new Date(2026, 8, 29, 9, 5).toISOString(), now)).toMatch(/^Yesterday /)
    expect(formatWhen(new Date(2025, 0, 2, 9, 5).toISOString(), now)).toMatch(/2025/)
  })
})
