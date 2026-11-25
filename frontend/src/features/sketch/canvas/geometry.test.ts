import type { Shape, Stroke, TextBox } from '../model'
import {
  distToSegment, hitItem, itemBounds, itemInLasso, pointInPolygon, polygonBounds, thinPoints, topItemAt, transformItem, transformRect, unionRects,
} from './geometry'

const stroke = (points: number[], width = 4): Stroke => ({ type: 'stroke', id: 's', tool: 'pen', color: 'ink', width, points })
const shape = (type: Shape['type'], x1: number, y1: number, x2: number, y2: number, width = 2): Shape => ({ type, id: type, color: '#ff0000', width, x1, y1, x2, y2 })
const text = (over: Partial<TextBox> = {}): TextBox => ({ type: 'text', id: 't', color: 'ink', x: 10, y: 20, size: 20, text: 'Hello', ...over })

describe('bounds', () => {
  it('covers a stroke and half its width', () => {
    expect(itemBounds(stroke([0, 0, 0.5, 100, 50, 0.5], 4))).toEqual({ minX: -2, minY: -2, maxX: 102, maxY: 52 })
  })

  it('covers a shape drawn from any corner', () => {
    expect(itemBounds(shape('rect', 50, 40, 10, 0, 2))).toEqual({ minX: 9, minY: -1, maxX: 51, maxY: 41 })
  })

  it('makes room for an arrow head', () => {
    const b = itemBounds(shape('arrow', 0, 0, 100, 0, 2))
    expect(b.maxX).toBeGreaterThan(101)
  })

  it('measures a text box by its lines', () => {
    const one = itemBounds(text({ text: 'Hi' }))
    const two = itemBounds(text({ text: 'Hi\nthere' }))
    expect(one.minX).toBe(10)
    expect(one.minY).toBe(20)
    expect(two.maxY - two.minY).toBeCloseTo((one.maxY - one.minY) * 2)
  })

  it('wraps a text box at its width', () => {
    const b = itemBounds(text({ text: 'one two three four five six', width: 60 }))
    expect(b.maxX - b.minX).toBeGreaterThanOrEqual(60)
    expect(b.maxY - b.minY).toBeGreaterThan(20 * 1.25 * 2)
  })

  it('unites boxes', () => {
    expect(unionRects([{ minX: 0, minY: 0, maxX: 1, maxY: 1 }, { minX: -5, minY: 2, maxX: 0, maxY: 9 }])).toEqual({ minX: -5, minY: 0, maxX: 1, maxY: 9 })
    expect(unionRects([])).toBeNull()
  })
})

describe('hit tests', () => {
  it('measures the distance to a segment', () => {
    expect(distToSegment(5, 5, 0, 0, 10, 0)).toBe(5)
    expect(distToSegment(-3, 4, 0, 0, 10, 0)).toBe(5)
    expect(distToSegment(3, 4, 0, 0, 0, 0)).toBe(5)
  })

  it('finds a stroke near its line only', () => {
    const s = stroke([0, 0, 0.5, 100, 0, 0.5, 100, 100, 0.5], 4)
    expect(hitItem(s, 50, 3, 2)).toBe(true)
    expect(hitItem(s, 50, 10, 2)).toBe(false)
    expect(hitItem(s, 98, 50, 2)).toBe(true)
    expect(hitItem(s, 50, 50, 2)).toBe(false)
  })

  it('finds a single dot', () => {
    expect(hitItem(stroke([10, 10, 0.5], 6), 12, 12, 1)).toBe(true)
  })

  it('finds a rectangle by its outline, not its inside', () => {
    const r = shape('rect', 0, 0, 100, 100)
    expect(hitItem(r, 0, 50, 2)).toBe(true)
    expect(hitItem(r, 50, 50, 2)).toBe(false)
  })

  it('finds an ellipse by its outline', () => {
    const e = shape('ellipse', 0, 0, 200, 100)
    expect(hitItem(e, 200, 50, 2)).toBe(true)
    expect(hitItem(e, 100, 0, 2)).toBe(true)
    expect(hitItem(e, 100, 50, 2)).toBe(false)
  })

  it('finds a line and a text box', () => {
    expect(hitItem(shape('line', 0, 0, 100, 100), 50, 51, 2)).toBe(true)
    expect(hitItem(text(), 15, 25, 0)).toBe(true)
    expect(hitItem(text(), 5, 25, 0)).toBe(false)
  })

  it('takes the topmost item', () => {
    const a = { ...shape('line', 0, 0, 100, 0), id: 'a' }
    const b = { ...shape('line', 0, 0, 100, 0), id: 'b' }
    expect(topItemAt([a, b], 50, 0, 2)?.id).toBe('b')
    expect(topItemAt([a, b], 50, 50, 2)).toBeNull()
  })
})

describe('lasso', () => {
  const square = [0, 0, 100, 0, 100, 100, 0, 100]

  it('tells inside from outside', () => {
    expect(pointInPolygon(50, 50, square)).toBe(true)
    expect(pointInPolygon(150, 50, square)).toBe(false)
    // A concave "U": its notch is outside.
    const u = [0, 0, 30, 0, 30, 70, 70, 70, 70, 0, 100, 0, 100, 100, 0, 100]
    expect(pointInPolygon(50, 30, u)).toBe(false)
    expect(pointInPolygon(50, 85, u)).toBe(true)
  })

  it('takes an item that is mostly inside', () => {
    const bounds = polygonBounds(square)
    expect(itemInLasso(stroke([10, 10, 0.5, 50, 50, 0.5, 90, 90, 0.5]), square, bounds)).toBe(true)
    expect(itemInLasso(stroke([10, 10, 0.5, 150, 150, 0.5, 190, 190, 0.5]), square, bounds)).toBe(false)
    expect(itemInLasso(shape('rect', 10, 10, 90, 90), square, bounds)).toBe(true)
    expect(itemInLasso(shape('rect', 10, 10, 190, 190), square, bounds)).toBe(false)
    expect(itemInLasso(text({ x: 10, y: 10, text: 'Hi' }), square, bounds)).toBe(true)
  })
})

describe('transforms', () => {
  it('moves and scales every kind of item', () => {
    const t = { dx: 10, dy: 0, scale: 2, ox: 0, oy: 0 }
    const s = transformItem(stroke([1, 1, 0.3, 2, 2, 0.7], 3), t)
    expect(s.points).toEqual([12, 2, 0.3, 14, 4, 0.7])
    expect(s.width).toBe(6)
    const r = transformItem(shape('rect', 0, 0, 10, 10), t)
    expect([r.x1, r.y1, r.x2, r.y2, r.width]).toEqual([10, 0, 30, 20, 4])
    const b = transformItem(text({ x: 5, y: 5, size: 10, width: 40 }), t)
    expect([b.x, b.y, b.size, b.width]).toEqual([20, 10, 20, 80])
  })

  it('keeps sizes within the limits', () => {
    const big = transformItem(stroke([0, 0, 0.5], 150), { dx: 0, dy: 0, scale: 10, ox: 0, oy: 0 })
    expect(big.width).toBe(200)
    const tiny = transformItem(text({ size: 5 }), { dx: 0, dy: 0, scale: 0.1, ox: 0, oy: 0 })
    expect(tiny.size).toBe(4)
    const far = transformItem(shape('line', 0, 0, 1, 1), { dx: 5e6, dy: 0, scale: 1, ox: 0, oy: 0 })
    expect(far.x1).toBe(1e6)
  })

  it('does not change the item it was given', () => {
    const s = stroke([1, 1, 0.5])
    transformItem(s, { dx: 1, dy: 1, scale: 1, ox: 0, oy: 0 })
    expect(s.points).toEqual([1, 1, 0.5])
  })

  it('transforms a box like its items', () => {
    expect(transformRect({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, { dx: 0, dy: 0, scale: 2, ox: 10, oy: 10 })).toEqual({ minX: -10, minY: -10, maxX: 10, maxY: 10 })
  })
})

describe('thinning out points', () => {
  it('drops points on a straight line and keeps the ends', () => {
    const points: number[] = []
    for (let i = 0; i <= 100; i++) points.push(i, i * 2, 0.5)
    expect(thinPoints(points)).toEqual([0, 0, 0.5, 100, 200, 0.5])
  })

  it('keeps the corners', () => {
    const points: number[] = []
    for (let i = 0; i <= 50; i++) points.push(i, 0, 0.5)
    for (let i = 1; i <= 50; i++) points.push(50, i, 0.5)
    const thin = thinPoints(points)
    expect(thin).toEqual([0, 0, 0.5, 50, 0, 0.5, 50, 50, 0.5])
  })

  it('keeps a change of pressure on a straight line', () => {
    const points: number[] = []
    for (let i = 0; i <= 100; i++) points.push(i, 0, i < 50 ? 0.2 : 0.9)
    const thin = thinPoints(points)
    expect(thin.length / 3).toBeGreaterThan(2)
    expect(thin.length / 3).toBeLessThan(8)
  })

  it('keeps a hand-drawn curve to a few dozen points', () => {
    // A 1.5-second loop sampled at 240 Hz, with a little tremor.
    const points: number[] = []
    let seed = 1
    const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.3
    for (let i = 0; i < 360; i++) {
      const a = (i / 360) * Math.PI * 1.6
      points.push(200 + Math.cos(a) * 80 + noise(), 200 + Math.sin(a) * 50 + noise(), 0.5 + Math.sin(a * 2) * 0.05)
    }
    const kept = thinPoints(points).length / 3
    expect(kept).toBeGreaterThan(10)
    expect(kept).toBeLessThan(60)
  })

  it('leaves one or two points alone', () => {
    expect(thinPoints([1, 2, 0.5])).toEqual([1, 2, 0.5])
    expect(thinPoints([1, 2, 0.5, 3, 4, 0.5])).toEqual([1, 2, 0.5, 3, 4, 0.5])
  })
})
