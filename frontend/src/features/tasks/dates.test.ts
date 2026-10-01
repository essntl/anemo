import { describe, expect, it } from 'vitest'
import { fromRRule, toRRule } from '@/features/calendar/recurrence'
import { addDays, bucketOf, formatDay, formatDue } from './dates'

const NOW = '2026-10-05' // a Monday

describe('task dates', () => {
  it('adds days across months and years', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
  })

  it('sorts open tasks into sections', () => {
    expect(bucketOf({ due_date: null }, NOW)).toBe('none')
    expect(bucketOf({ due_date: '2026-10-04' }, NOW)).toBe('overdue')
    expect(bucketOf({ due_date: NOW }, NOW)).toBe('today')
    expect(bucketOf({ due_date: '2026-10-12' }, NOW)).toBe('upcoming')
    expect(bucketOf({ due_date: '2026-10-13' }, NOW)).toBe('later')
  })

  it('names nearby days', () => {
    expect(formatDay(NOW, NOW)).toBe('Today')
    expect(formatDay('2026-10-06', NOW)).toBe('Tomorrow')
    expect(formatDay('2026-10-04', NOW)).toBe('Yesterday')
    expect(formatDay('2027-03-01', NOW)).toMatch(/2027/)
    expect(formatDue({ due_date: NOW, due_time: '14:30:00' }, NOW)).toBe('Today 14:30')
    expect(formatDue({ due_date: null, due_time: null }, NOW)).toBe('')
  })
})

describe('repeat rules', () => {
  it('turns the dialog choices into a rule and back', () => {
    expect(toRRule('none', '', '')).toBeNull()
    expect(toRRule('weekly', '', '')).toBe('FREQ=WEEKLY')
    const rule = toRRule('biweekly', '2026-12-31', '')
    expect(rule).toBe('FREQ=WEEKLY;INTERVAL=2;UNTIL=20261231T235959')
    expect(fromRRule(rule)).toEqual({ repeat: 'biweekly', until: '2026-12-31' })
    expect(fromRRule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')).toEqual({ repeat: 'weekdays', until: '' })
    expect(fromRRule(null)).toEqual({ repeat: 'none', until: '' })
  })

  it('keeps rules it has no preset for', () => {
    const custom = 'FREQ=MONTHLY;BYDAY=1MO'
    expect(fromRRule(custom).repeat).toBe('custom')
    expect(toRRule('custom', '', custom)).toBe(custom)
  })
})
