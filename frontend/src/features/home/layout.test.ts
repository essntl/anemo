import { describe, expect, it } from 'vitest'
import { DEFAULT_LAYOUT, moveWidget, normalizeLayout, patchWidget, resizeWidget, WIDGET_IDS } from './layout'

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
})
