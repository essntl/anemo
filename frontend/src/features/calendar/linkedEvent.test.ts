import { describe, expect, it } from 'vitest'
import type { CalendarEvent } from './api'
import { linkedEventDay } from './linkedEvent'

const event = (fields: Partial<CalendarEvent>) => ({ all_day: false, start_date: null, rrule: null, start_at: '2026-12-05T10:00:00', ...fields }) as CalendarEvent

describe("the day an event's link opens on", () => {
  it('is the day it starts', () => {
    expect(linkedEventDay(event({}), '2026-11-20')).toBe('2026-12-05')
    expect(linkedEventDay(event({ all_day: true, start_date: '2026-10-01' }), '2026-11-20')).toBe('2026-10-01')
  })

  it('is today for a repeating event that started earlier', () => {
    expect(linkedEventDay(event({ rrule: 'FREQ=WEEKLY', start_at: '2026-01-05T10:00:00' }), '2026-11-20')).toBe('2026-11-20')
    expect(linkedEventDay(event({ rrule: 'FREQ=WEEKLY' }), '2026-11-20')).toBe('2026-12-05')
  })
})
