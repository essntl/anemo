import type { Shape, Stroke } from '../model'
import { handleAt, resizeTransform, selectInLasso, selectionBounds } from './lasso'

const dot = (id: string, x: number, y: number): Stroke => ({ type: 'stroke', id, tool: 'pen', color: 'ink', width: 2, points: [x, y, 0.5, x + 4, y, 0.5] })
const box: Shape = { type: 'rect', id: 'r', color: 'ink', width: 2, x1: 0, y1: 0, x2: 100, y2: 50 }

describe('selection', () => {
  it('takes what the lasso goes round', () => {
    const items = [dot('in', 20, 20), dot('out', 200, 20), box]
    expect(selectInLasso(items, [0, 0, 60, 0, 60, 60, 0, 60])).toEqual(['in'])
    expect(selectInLasso(items, [-10, -10, 120, -10, 120, 70, -10, 70])).toEqual(['in', 'r'])
    expect(selectInLasso(items, [0, 0, 10, 10])).toEqual([])
  })

  it('has a box around the chosen items', () => {
    const items = [dot('a', 0, 0), dot('b', 100, 100)]
    expect(selectionBounds(items, new Set(['a', 'b']))).toEqual({ minX: -1, minY: -1, maxX: 105, maxY: 101 })
    expect(selectionBounds(items, new Set())).toBeNull()
  })

  it('finds a corner handle, more loosely when zoomed out', () => {
    const frame = { minX: 0, minY: 0, maxX: 100, maxY: 100 }
    expect(handleAt(frame, 101, 99, 1)).toBe('se')
    expect(handleAt(frame, -5, 2, 1)).toBe('nw')
    expect(handleAt(frame, 50, 50, 1)).toBeNull()
    expect(handleAt(frame, 120, 100, 1)).toBeNull()
    expect(handleAt(frame, 120, 100, 0.5)).toBe('se')
  })

  it('resizes from the opposite corner, keeping proportions', () => {
    const frame = { minX: 0, minY: 0, maxX: 100, maxY: 50 }
    const t = resizeTransform(frame, 'se', { x: 200, y: 100 })
    expect(t).toMatchObject({ scale: 2, ox: 0, oy: 0 })
    const nw = resizeTransform(frame, 'nw', { x: 50, y: 25 })
    expect(nw).toMatchObject({ ox: 100, oy: 50 })
    expect(nw.scale).toBeCloseTo(0.5)
  })

  it('never turns a selection inside out', () => {
    const t = resizeTransform({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, 'se', { x: -50, y: -50 })
    expect(t.scale).toBeGreaterThan(0)
  })
})
