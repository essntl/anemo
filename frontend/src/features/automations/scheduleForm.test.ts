import { describe, expect, it } from 'vitest'
import { formatUpcoming } from '@/lib/format'
import { defaultForm, fromSchedule, type Schedule, type ScheduleForm, toSchedule } from './scheduleForm'

const TZ = 'Europe/Amsterdam'
const form = (patch: Partial<ScheduleForm>): ScheduleForm => ({ ...defaultForm(new Date(2026, 9, 1)), ...patch })
const cron = (expr: string): Schedule => ({ kind: 'cron', cron: expr, every_minutes: null, at: null, tz: TZ })

describe('schedule editor', () => {
  it('turns the simple choices into schedules', () => {
    expect(toSchedule(form({ frequency: 'daily', time: '08:05' }), TZ)).toEqual(cron('5 8 * * *'))
    expect(toSchedule(form({ frequency: 'weekdays', time: '17:30' }), TZ)).toEqual(cron('30 17 * * 1-5'))
    expect(toSchedule(form({ frequency: 'weekly', time: '09:00', weekday: 0 }), TZ)).toEqual(cron('0 9 * * 0'))
    expect(toSchedule(form({ frequency: 'monthly', time: '07:00', monthDay: 15 }), TZ)).toEqual(cron('0 7 15 * *'))
    expect(toSchedule(form({ frequency: 'hours', every: 3 }), TZ)).toMatchObject({ kind: 'interval', every_minutes: 180 })
    expect(toSchedule(form({ frequency: 'minutes', every: 2 }), TZ)).toMatchObject({ kind: 'interval', every_minutes: 5 })
    expect(toSchedule(form({ frequency: 'cron', cron: ' 0 6 * * 1,3 ' }), TZ)).toEqual(cron('0 6 * * 1,3'))
  })

  it('stores a one-time run as a moment in the browser time zone', () => {
    const once = toSchedule(form({ frequency: 'once', date: '2026-10-05', time: '09:30' }), TZ)
    expect(once.kind).toBe('once')
    expect(new Date(once.at!).getTime()).toBe(new Date(2026, 9, 5, 9, 30).getTime())
    expect(fromSchedule(once)).toMatchObject({ frequency: 'once', date: '2026-10-05', time: '09:30' })
  })

  it('reads schedules back into the same choices', () => {
    for (const choice of [
      form({ frequency: 'daily', time: '08:05' }),
      form({ frequency: 'weekdays', time: '17:30' }),
      form({ frequency: 'weekly', time: '09:00', weekday: 6 }),
      form({ frequency: 'monthly', time: '07:00', monthDay: 15 }),
      form({ frequency: 'hours', every: 3 }),
      form({ frequency: 'minutes', every: 45 }),
    ]) {
      const back = fromSchedule(toSchedule(choice, TZ))
      expect(toSchedule(back, TZ)).toEqual(toSchedule(choice, TZ))
      expect(back.frequency).toBe(choice.frequency)
    }
  })

  it('keeps schedules it has no simple choice for as cron', () => {
    expect(fromSchedule(cron('0 6 * * 1,3'))).toMatchObject({ frequency: 'cron', cron: '0 6 * * 1,3' })
    expect(fromSchedule(cron('*/15 9-17 * * *'))).toMatchObject({ frequency: 'cron' })
    expect(fromSchedule(cron('0 6 1 * 1'))).toMatchObject({ frequency: 'cron' })
    expect(fromSchedule(cron('0 9 * * 7'))).toMatchObject({ frequency: 'weekly', weekday: 0 }) // 7 is Sunday too
  })
})

describe('upcoming times', () => {
  it('names today and tomorrow', () => {
    const now = new Date(2026, 8, 30, 15, 0)
    expect(formatUpcoming(new Date(2026, 8, 30, 18, 0).toISOString(), now)).toMatch(/^Today /)
    expect(formatUpcoming(new Date(2026, 9, 1, 8, 0).toISOString(), now)).toMatch(/^Tomorrow /)
    expect(formatUpcoming(new Date(2026, 9, 5, 8, 0).toISOString(), now)).toMatch(/5/)
    expect(formatUpcoming(new Date(2027, 0, 5, 8, 0).toISOString(), now)).toMatch(/2027/)
  })
})
