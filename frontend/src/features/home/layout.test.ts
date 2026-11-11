import { describe, expect, it } from 'vitest'
import { DEFAULT_LAYOUT, layoutFor, moveWidget, normalizeLayout, patchWidget, resizeWidget, WIDGET_IDS } from './layout'

describe('home layout', () => {
  it('fills an empty or broken layout with the defaults', () => {
    for (const saved of [[], null, 'nonsense', [{ nope: 1 }]]) {
      const out = normalizeLayout(saved)
      expect(out.map((w) => w.id)).toEqual(DEFAULT_LAYOUT.map((w) => w.id))
    }
    expect(normalizeLayout([]).find((w) => w.id === 'briefing')?.hidden).toBe(true)
  })

  it('keeps the saved order and sizes, drops unknown and repeated widgets, adds new ones at the end', () => {
    const saved = [
      { id: 'music', w: 3, h: 2 },
      { id: 'habits', w: 1, h: 1 }, // a widget that no longer exists
      { id: 'focus', w: 9, h: 0, hidden: true },
      { id: 'music', w: 1, h: 1 },
    ]
    const out = normalizeLayout(saved)
    expect(out.slice(0, 2)).toEqual([
      { id: 'music', w: 3, h: 2, hidden: false, pinned: false, options: {} },
      { id: 'focus', w: 3, h: 1, hidden: true, pinned: false, options: {} },
    ])
    expect(out.map((w) => w.id).sort()).toEqual([...WIDGET_IDS].sort())
    expect(out).toHaveLength(WIDGET_IDS.length)
  })

  it('puts the daily note after Today: in the default layout, and in layouts saved before it existed', () => {
    const ids = (l: { id: string }[]) => l.map((w) => w.id)
    expect(ids(normalizeLayout([])).slice(0, 3)).toEqual(['focus', 'today', 'daily'])
    const saved = [
      { id: 'music', w: 1, h: 1 },
      { id: 'today', w: 2, h: 1, hidden: true },
      { id: 'focus', w: 1, h: 2 },
    ]
    expect(ids(normalizeLayout(saved)).slice(0, 4)).toEqual(['music', 'today', 'daily', 'focus'])
    expect(normalizeLayout(saved).find((w) => w.id === 'daily')).toMatchObject({ w: 1, h: 2, hidden: false })
    // Without Today it goes at the end, like any widget added later.
    expect(ids(normalizeLayout([{ id: 'music', w: 1, h: 1 }])).at(-1)).toBe('briefing')
    expect(ids(normalizeLayout([{ id: 'music', w: 1, h: 1 }]))).toContain('daily')
    // Once saved, it stays where the user put it.
    expect(ids(normalizeLayout([{ id: 'daily', w: 1, h: 1 }, { id: 'today', w: 1, h: 1 }])).slice(0, 2)).toEqual(['daily', 'today'])
  })

  it('keeps widget options', () => {
    const out = normalizeLayout([{ id: 'briefing', w: 1, h: 2, options: { automation_id: 'a1' } }])
    expect(out[0].options).toEqual({ automation_id: 'a1' })
  })

  it('moves, resizes and changes widgets without touching the original', () => {
    const base = normalizeLayout([])
    const moved = moveWidget(base, 'music', 0)
    expect(moved[0].id).toBe('music')
    expect(base[0].id).toBe('focus')
    expect(moveWidget(base, 'focus', 0)).toBe(base)
    expect(moveWidget(base, 'focus', 99).at(-1)?.id).toBe('focus')

    const bigger = resizeWidget(base, 'music', 5, 2)
    expect(bigger.find((w) => w.id === 'music')).toMatchObject({ w: 3, h: 2 })
    expect(resizeWidget(base, 'music', 1, 1)).toBe(base)

    expect(patchWidget(base, 'needs', { pinned: true }).find((w) => w.id === 'needs')?.pinned).toBe(true)
  })

  it('gives phones their own layout, which follows the wider one until it is set', () => {
    const wide = [{ id: 'music', w: 2, h: 1 }]
    const phone = [{ id: 'today', w: 1, h: 1 }]
    expect(layoutFor({ layout: wide }, true)[0].id).toBe('music')
    expect(layoutFor({ layout: wide, mobile_layout: [] }, true)[0].id).toBe('music')
    expect(layoutFor({ layout: wide, mobile_layout: phone }, true)[0].id).toBe('today')
    expect(layoutFor({ layout: wide, mobile_layout: phone }, false)[0].id).toBe('music')
    expect(layoutFor(undefined, true).map((w) => w.id)).toEqual(DEFAULT_LAYOUT.map((w) => w.id))
  })
})

describe('widgetAvailable', () => {
  it('drops the widgets of a page that is turned off', async () => {
    const { widgetAvailable } = await import('./layout')
    expect(widgetAvailable('music', ['music'])).toBe(false)
    expect(widgetAvailable('week', ['focus'])).toBe(false)
    expect(widgetAvailable('focus', ['music'])).toBe(true)
    // Today shows tasks and events: it stays while one of the two is on.
    expect(widgetAvailable('today', ['tasks'])).toBe(true)
    expect(widgetAvailable('today', ['tasks', 'calendar'])).toBe(false)
    // Not tied to a page that can be turned off.
    expect(widgetAvailable('ask', ['tasks', 'calendar', 'music', 'focus'])).toBe(true)
  })
})
