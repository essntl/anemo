import { describe, expect, it } from 'vitest'
import { describeRepeat, repeatOptions } from './repeat'

describe('repeating tasks', () => {
  it('reads rules', () => {
    expect(describeRepeat('FREQ=WEEKLY')).toBe('Every week')
    expect(describeRepeat('FREQ=WEEKLY;INTERVAL=3;BYDAY=MO,TH')).toBe('Every 3 weeks on Mon, Thu')
    expect(describeRepeat('FREQ=MONTHLY;BYMONTHDAY=1')).toBe('Every month on day 1')
    expect(describeRepeat('FREQ=DAILY;UNTIL=20261231T235959')).toBe('Every day until 2026-12-31')
    expect(describeRepeat('FREQ=HOURLY')).toBe('Repeats')
  })
  it('offers the current rule when it is not a simple choice', () => {
    expect(repeatOptions('FREQ=DAILY').at(-1)?.label).toBe('Every year')
    expect(repeatOptions('FREQ=MONTHLY;BYMONTHDAY=15').at(-1)).toEqual({ value: 'FREQ=MONTHLY;BYMONTHDAY=15', label: 'Every month on day 15' })
  })
})
