import { describe, expect, it } from 'vitest'
import { DEFAULT_NAVIGATION, isOffAddress, movePage, normalizeNavigation, pageAt, placeOf, shiftPage, type Navigation } from './navigation'

describe('normalizeNavigation', () => {
  it('is the default until something is saved', () => {
    expect(normalizeNavigation(undefined)).toEqual(DEFAULT_NAVIGATION)
  })

  it('puts a page that is in no list under More', () => {
    const nav = normalizeNavigation({ pinned: ['home', 'music'], more: ['tasks'], off: ['focus'] })
    expect(nav.pinned).toEqual(['home', 'music'])
    expect(nav.off).toEqual(['focus'])
    expect(nav.more.slice(0, 2)).toEqual(['tasks', 'notifications'])
    expect([...nav.pinned, ...nav.more, ...nav.off].sort()).toEqual([...DEFAULT_NAVIGATION.pinned, ...DEFAULT_NAVIGATION.more].sort())
  })

  it('drops unknown pages and repeats, and never has Home or the Inbox off', () => {
    const saved = { pinned: ['home', 'home', 'casino'], more: ['tasks'], off: ['notifications', 'tasks', 'music'] } as unknown as Navigation
    const nav = normalizeNavigation(saved)
    expect(nav.pinned).toEqual(['home'])
    // Off wins over a second place; the Inbox comes back under More.
    expect(nav.off).toEqual(['tasks', 'music'])
    expect(nav.more).toContain('notifications')
    expect(nav.more).not.toContain('tasks')
  })
})

describe('moving pages', () => {
  it('moves a page to the end of another list', () => {
    const nav = movePage(DEFAULT_NAVIGATION, 'music', 'pinned')
    expect(nav.pinned.at(-1)).toBe('music')
    expect(nav.more).not.toContain('music')
    expect(placeOf(movePage(nav, 'music', 'off'), 'music')).toBe('off')
  })

  it('does not turn Home or the Inbox off', () => {
    expect(movePage(DEFAULT_NAVIGATION, 'home', 'off')).toBe(DEFAULT_NAVIGATION)
    expect(placeOf(movePage(DEFAULT_NAVIGATION, 'notifications', 'more'), 'notifications')).toBe('more')
  })

  it('shifts a page within its list, and stops at the ends', () => {
    expect(shiftPage(DEFAULT_NAVIGATION, 'tasks', -1).pinned.slice(0, 3)).toEqual(['home', 'tasks', 'notifications'])
    expect(shiftPage(DEFAULT_NAVIGATION, 'home', -1)).toBe(DEFAULT_NAVIGATION)
    expect(shiftPage(DEFAULT_NAVIGATION, 'memory', 1)).toBe(DEFAULT_NAVIGATION)
  })
})

describe('addresses', () => {
  it('knows which page an address belongs to', () => {
    expect(pageAt('/runs/abc')).toBe('runs')
    expect(pageAt('/stats')).toBe('focus')
    expect(pageAt('/settings/focus')).toBeUndefined()
    expect(pageAt('/musical')).toBeUndefined()
  })

  it('says when an address is of a page that is off', () => {
    expect(isOffAddress('/music', ['music'])).toBe(true)
    expect(isOffAddress('/stats?range=week', ['focus'])).toBe(true)
    expect(isOffAddress('/tasks', ['music'])).toBe(false)
    expect(isOffAddress('/c/123', ['music'])).toBe(false)
  })
})
