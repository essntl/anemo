import { describe, expect, it } from 'vitest'
import { autoPlace, closeHoles, firstFree, moveTo, type Place, placesOf, reflow, toFullGrid, withPlaces } from './gridPlaces'
import { DEFAULT_LAYOUT, normalizeLayout, type WidgetId } from './layout'

const obj = (m: Map<WidgetId, Place>) => Object.fromEntries(m)

describe('the free grid', () => {
  it('lays out the slots as the browser does', () => {
    // 1x2, 1x2, 1x2, then a 2x1 goes under them, a 1x1 beside it.
    expect(autoPlace([{ w: 1, h: 2 }, { w: 1, h: 2 }, { w: 1, h: 2 }, { w: 2, h: 1 }, { w: 1, h: 1 }], 3)).toEqual([
      { x: 0, y: 0, w: 1, h: 2 }, { x: 1, y: 0, w: 1, h: 2 }, { x: 2, y: 0, w: 1, h: 2 },
      { x: 0, y: 2, w: 2, h: 1 }, { x: 2, y: 2, w: 1, h: 1 },
    ])
    // A 3-wide item after a 1-wide one starts a new row; the cursor never goes back.
    expect(autoPlace([{ w: 1, h: 1 }, { w: 3, h: 1 }, { w: 1, h: 1 }], 3)).toEqual([
      { x: 0, y: 0, w: 1, h: 1 }, { x: 0, y: 1, w: 3, h: 1 }, { x: 0, y: 2, w: 1, h: 1 },
    ])
  })

  it('gives a layout never arranged on the grid its slot places, scaled to 12 columns', () => {
    const places = placesOf(normalizeLayout(DEFAULT_LAYOUT))
    // focus, today, daily side by side (1x2 slots = 4 columns, 4 rows).
    expect(places.get('focus')).toEqual({ x: 0, y: 0, w: 4, h: 4 })
    expect(places.get('today')).toEqual({ x: 4, y: 0, w: 4, h: 4 })
    expect(places.get('daily')).toEqual({ x: 8, y: 0, w: 4, h: 4 })
    expect(places.get('music')).toEqual({ x: 0, y: 4, w: 4, h: 2 })
    expect(places.get('board')?.w).toBe(12)
    expect(places.has('briefing')).toBe(false) // hidden
  })

  it('keeps saved places, and finds a free spot for a widget added since', () => {
    const layout = normalizeLayout([
      { id: 'focus', w: 1, h: 1, grid: { x: 6, y: 0, w: 6, h: 3 } },
      { id: 'music', w: 1, h: 1, grid: { x: 0, y: 0, w: 6, h: 2 } },
    ]).map((w) => (w.id === 'focus' || w.id === 'music' || w.id === 'today' ? w : { ...w, hidden: true }))
    const places = placesOf(layout)
    expect(places.get('focus')).toEqual({ x: 6, y: 0, w: 6, h: 3 })
    // today (1x2 slot = 4x4) under music, the first spot where it fits.
    expect(places.get('today')).toEqual({ x: 0, y: 2, w: 4, h: 4 })
  })

  it('moves the widgets a moved one now covers down, and those under them after', () => {
    const start = new Map<WidgetId, Place>([
      ['focus', { x: 0, y: 0, w: 4, h: 2 }],
      ['music', { x: 0, y: 2, w: 4, h: 2 }],
      ['today', { x: 0, y: 4, w: 4, h: 2 }],
      ['tasks', { x: 8, y: 0, w: 4, h: 2 }],
    ])
    const next = moveTo(start, ['focus', 'music', 'today', 'tasks'], 'tasks', { x: 0, y: 1, w: 6, h: 2 })
    expect(obj(next)).toEqual({
      tasks: { x: 0, y: 1, w: 6, h: 2 },
      focus: { x: 0, y: 3, w: 4, h: 2 },
      music: { x: 0, y: 5, w: 4, h: 2 },
      today: { x: 0, y: 7, w: 4, h: 2 },
    })
    // Kept on the grid and within the sizes.
    expect(moveTo(start, ['focus'], 'focus', { x: 11, y: -3, w: 1, h: 40 }).get('focus')).toEqual({ x: 10, y: 0, w: 2, h: 12 })
  })

  it('reflows on fewer columns without overlaps, and maps a place back to 12 columns', () => {
    const places = new Map<WidgetId, Place>([
      ['focus', { x: 0, y: 0, w: 4, h: 2 }],
      ['music', { x: 4, y: 0, w: 4, h: 2 }],
      ['today', { x: 8, y: 0, w: 4, h: 2 }],
    ])
    const narrow = reflow(places, ['focus', 'music', 'today'], 6)
    expect(obj(narrow)).toEqual({
      focus: { x: 0, y: 0, w: 2, h: 2 },
      music: { x: 2, y: 0, w: 2, h: 2 },
      today: { x: 4, y: 0, w: 2, h: 2 },
    })
    const tight = reflow(new Map<WidgetId, Place>([['focus', { x: 0, y: 0, w: 7, h: 2 }], ['music', { x: 5, y: 0, w: 7, h: 2 }]]), ['focus', 'music'], 6)
    expect(tight.get('music')).toEqual({ x: 2, y: 2, w: 4, h: 2 }) // would overlap: moved down
    expect(toFullGrid({ x: 2, y: 3, w: 2, h: 2 }, 6)).toEqual({ x: 4, y: 3, w: 4, h: 2 })
  })

  it('closes the hole a widget that hides itself leaves, but not a gap left on purpose', () => {
    const places = new Map<WidgetId, Place>([
      ['needs', { x: 0, y: 0, w: 4, h: 2 }],
      ['music', { x: 0, y: 2, w: 4, h: 2 }],
      ['today', { x: 0, y: 4, w: 4, h: 2 }],
      ['tasks', { x: 6, y: 5, w: 4, h: 2 }], // under a gap, not under "needs"
    ])
    const out = closeHoles(places, ['music', 'today', 'tasks'], ['needs'])
    expect(out.get('music')).toEqual({ x: 0, y: 0, w: 4, h: 2 })
    expect(out.get('today')).toEqual({ x: 0, y: 2, w: 4, h: 2 })
    expect(out.get('tasks')).toEqual({ x: 6, y: 5, w: 4, h: 2 })
    // Wider than the hole: stays.
    const wide = closeHoles(new Map<WidgetId, Place>([['needs', { x: 0, y: 0, w: 4, h: 2 }], ['board', { x: 0, y: 2, w: 8, h: 2 }]]), ['board'], ['needs'])
    expect(wide.get('board')?.y).toBe(2)
  })

  it('finds the first free spot from the top', () => {
    expect(firstFree({ w: 4, h: 2 }, [{ x: 0, y: 0, w: 10, h: 2 }])).toEqual({ x: 0, y: 2, w: 4, h: 2 })
    expect(firstFree({ w: 2, h: 2 }, [{ x: 0, y: 0, w: 10, h: 2 }])).toEqual({ x: 10, y: 0, w: 2, h: 2 })
  })

  it('writes the places into the saved layout', () => {
    const layout = normalizeLayout(DEFAULT_LAYOUT)
    const out = withPlaces(layout, new Map([['focus', { x: 1, y: 2, w: 3, h: 4 }]]))
    expect(out.find((w) => w.id === 'focus')?.grid).toEqual({ x: 1, y: 2, w: 3, h: 4 })
    expect(out.find((w) => w.id === 'music')?.grid).toBeNull()
  })
})

describe('the free grid, from the slots as shown', () => {
  it('leaves out a widget that hides itself, as the usual grid does, and gives it a free spot after', () => {
    const layout = normalizeLayout(DEFAULT_LAYOUT)
    const places = placesOf(layout, (w) => !!w.hidden, (w) => w.id === 'needs')
    // Without "Needs you", Ask Anemo comes up beside Music (as on the page).
    expect(places.get('music')).toEqual({ x: 0, y: 4, w: 4, h: 2 })
    expect(places.get('ask')).toEqual({ x: 4, y: 4, w: 8, h: 2 })
    const needs = places.get('needs')!
    for (const [id, p] of places) {
      if (id === 'needs') continue
      const overlap = needs.x < p.x + p.w && p.x < needs.x + needs.w && needs.y < p.y + p.h && p.y < needs.y + needs.h
      expect(overlap, id).toBe(false)
    }
  })
})
