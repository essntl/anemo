import { describe, expect, it } from 'vitest'
import { rangeFor, toBars } from './ranges'

const series = (from: string, n: number, value = 1) =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(`${from}T12:00:00`)
    d.setDate(d.getDate() + i)
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return { day, value }
  })

describe('stats ranges', () => {
  it('ends ranges today', () => {
    expect(rangeFor('week', '2026-10-27')).toEqual({ from: '2026-10-21', to: '2026-10-27' })
    expect(rangeFor('month', '2026-10-27')).toEqual({ from: '2026-09-28', to: '2026-10-27' })
    expect(rangeFor('half', '2026-10-27').from).toBe('2026-04-29')
  })

  it('shows days as bars, and weeks for long ranges', () => {
    const week = toBars(series('2026-10-21', 7), '2026-10-27')
    expect(week).toHaveLength(7)
    expect(week.at(-1)?.highlight).toBe(true)
    // 182 days from a Wednesday: a partial first week, then whole weeks (Monday first).
    const half = toBars(series('2026-04-29', 182), '2026-10-27')
    expect(half.length).toBe(27)
    expect(half[0].value).toBe(5) // Wed..Sun
    expect(half[1].value).toBe(7)
    expect(half.reduce((s, b) => s + b.value, 0)).toBe(182)
    expect(half.at(-1)?.highlight).toBe(true)
  })
})
