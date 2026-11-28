import { describe, expect, it } from 'vitest'
import { byDay, categoryOf, countByCategory, dayOf } from './inbox'

const now = new Date(2026, 10, 27, 9, 30) // 27 Nov, 09:30 local time
const at = (day: number, hour: number) => new Date(2026, 10, day, hour).toISOString()

describe('the Inbox notification groups', () => {
  it('sorts a notification into a category: a finished job by its link', () => {
    expect(categoryOf({ kind: 'agent', link: '/code/0190' })).toBe('job')
    expect(categoryOf({ kind: 'agent', link: '/c/42' })).toBe('agent')
    expect(categoryOf({ kind: 'approval', link: null })).toBe('agent')
    expect(categoryOf({ kind: 'automation', link: '/automations' })).toBe('automation')
    expect(categoryOf({ kind: 'reminder', link: '/tasks' })).toBe('reminder')
    expect(categoryOf({ kind: 'focus', link: null })).toBe('system')
  })

  it('uses calendar days for Today and Yesterday, not 24-hour spans', () => {
    expect(dayOf(at(27, 0), now)).toBe('today')
    expect(dayOf(at(26, 23), now)).toBe('yesterday') // under 24 hours ago, but yesterday
    expect(dayOf(at(26, 0), now)).toBe('yesterday')
    expect(dayOf(at(25, 23), now)).toBe('earlier')
  })

  it('groups by day in order and leaves out empty days', () => {
    const notes = [{ id: 'a', created_at: at(27, 8) }, { id: 'b', created_at: at(20, 8) }, { id: 'c', created_at: at(27, 7) }]
    expect(byDay(notes, now)).toEqual([
      { day: 'today', notes: [notes[0], notes[2]] },
      { day: 'earlier', notes: [notes[1]] },
    ])
  })

  it('counts each category', () => {
    expect(countByCategory([{ kind: 'agent', link: '/code/1' }, { kind: 'agent', link: '/code/2' }, { kind: 'reminder', link: null }]))
      .toEqual({ job: 2, automation: 0, reminder: 1, agent: 0, system: 0 })
  })
})
