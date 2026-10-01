import { formatCost, formatCount, formatDuration, formatWhen } from './format'

describe('formatters', () => {
  it('formats durations', () => {
    expect(formatDuration(42)).toBe('42 s')
    expect(formatDuration(185)).toBe('3 min 5 s')
    expect(formatDuration(120)).toBe('2 min')
    expect(formatDuration(7300)).toBe('2 h 1 min')
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
