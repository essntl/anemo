import { describe, expect, it } from 'vitest'
import { parseQuickAdd } from './quickAdd'

// A Tuesday.
const NOW = '2026-11-10'

describe('parseQuickAdd', () => {
  it('a plain title stays as typed', () => {
    expect(parseQuickAdd('Water the plants', NOW)).toEqual({ title: 'Water the plants', due_date: null, priority: 0, tags: [] })
  })

  it('reads a day, a priority and tags off the end', () => {
    expect(parseQuickAdd('Call the bank fri !high', NOW)).toEqual({ title: 'Call the bank', due_date: '2026-11-13', priority: 3, tags: [] })
    expect(parseQuickAdd('Buy stamps #errands #post tomorrow', NOW)).toEqual({ title: 'Buy stamps', due_date: '2026-11-11', priority: 0, tags: ['errands', 'post'] })
    expect(parseQuickAdd('Renew the domain today !low', NOW)).toMatchObject({ title: 'Renew the domain', due_date: NOW, priority: 1 })
  })

  it('a weekday means the next one, a week on when it is today', () => {
    expect(parseQuickAdd('Gym monday', NOW).due_date).toBe('2026-11-16')
    expect(parseQuickAdd('Seminar tuesday', NOW).due_date).toBe('2026-11-17')
    expect(parseQuickAdd('Plan next week', NOW)).toMatchObject({ title: 'Plan', due_date: '2026-11-17' })
  })

  it('takes the word that leads up to the day with it', () => {
    expect(parseQuickAdd('Pay rent by friday', NOW)).toMatchObject({ title: 'Pay rent', due_date: '2026-11-13' })
    expect(parseQuickAdd('Slides due thu', NOW)).toMatchObject({ title: 'Slides', due_date: '2026-11-12' })
  })

  it('leaves such words alone when they are not at the end', () => {
    expect(parseQuickAdd('Read Friday Night Lights', NOW)).toMatchObject({ title: 'Read Friday Night Lights', due_date: null })
    expect(parseQuickAdd('Ask about #budget numbers', NOW)).toMatchObject({ title: 'Ask about #budget numbers', tags: [] })
  })

  it('never empties the title, and ignores short lookalikes', () => {
    expect(parseQuickAdd('today', NOW)).toMatchObject({ title: 'today', due_date: null })
    expect(parseQuickAdd('Buy a sun', NOW)).toMatchObject({ title: 'Buy a', due_date: '2026-11-15' })
    expect(parseQuickAdd('Check the mo', NOW)).toMatchObject({ title: 'Check the mo', due_date: null })
  })
})
