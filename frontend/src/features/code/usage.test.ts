import { describe, expect, it } from 'vitest'
import { type CodeUsage, percent, usageOf, usageWindows, windowLabel } from './usage'

const NOW = new Date('2026-11-26T12:00:00Z')

function usage(windows: CodeUsage['windows'], more: Partial<CodeUsage> = {}): CodeUsage {
  return {
    device_id: 'dev-1', device_name: 'Desk PC', status: 'allowed', limit_type: 'five_hour', resets_at: null,
    windows, observed_at: '2026-11-26T11:50:00Z', job_id: null, ...more,
  }
}

describe('the usage windows', () => {
  it('shows the 5-hour and the weekly window first, the others after', () => {
    const { main, other } = usageWindows(usage([
      { name: 'seven_day_overage_included', utilization: 0.25, resets_at: '2026-11-30T10:00:00Z', status: 'allowed' },
      { name: 'seven_day', utilization: 0.25, resets_at: '2026-11-30T10:00:00Z', status: 'allowed' },
      { name: 'seven_day_opus', utilization: 0.1, resets_at: '2026-11-30T10:00:00Z', status: 'allowed' },
      { name: 'five_hour', utilization: 0.49, resets_at: '2026-11-26T15:00:00Z', status: 'allowed' },
    ]), NOW)
    expect(main.map((v) => [v.name, v.used])).toEqual([['five_hour', 0.49], ['seven_day', 0.25]])
    // The overage window repeats the weekly one: left out.
    expect(other.map((v) => v.name)).toEqual(['seven_day_opus'])
    expect(main[0]).toMatchObject({ reset: false, limited: false, warning: false })
  })

  it('warns near the limit and marks it hit', () => {
    const { main } = usageWindows(usage([
      { name: 'five_hour', utilization: 1.02, resets_at: '2026-11-26T15:00:00Z', status: 'rejected' },
      { name: 'seven_day', utilization: 0.85, resets_at: '2026-11-30T10:00:00Z', status: 'allowed' },
    ]), NOW)
    expect(main[0]).toMatchObject({ limited: true, warning: false, used: 1.02 })
    expect(main[1]).toMatchObject({ limited: false, warning: true })
    expect(percent(1.02)).toBe('102%')
  })

  it('says a window has reset once its reset time passed, without the old share', () => {
    const { main } = usageWindows(usage([
      { name: 'five_hour', utilization: 1.02, resets_at: '2026-11-26T11:00:00Z', status: 'rejected' },
    ]), NOW)
    expect(main[0]).toMatchObject({ reset: true, used: null, limited: false })
  })

  it('takes odd values without breaking', () => {
    const { main } = usageWindows(usage([{ name: 'weekly_x', utilization: null, resets_at: 'not a date', status: null }]), NOW)
    expect(main).toHaveLength(1)
    expect(main[0]).toMatchObject({ used: null, resetsAt: null, reset: false })
    expect(windowLabel('weekly_x')).toBe('weekly x')
    expect(windowLabel('five_hour')).toBe('5-hour')
  })

  it('finds a computer’s usage', () => {
    const one = usage([])
    expect(usageOf([one], 'dev-1')).toBe(one)
    expect(usageOf([one], 'dev-2')).toBeUndefined()
    expect(usageOf(undefined, 'dev-1')).toBeUndefined()
  })
})
