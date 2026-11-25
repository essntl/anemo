import { LIMITS, type SketchItem, type Stroke, type TextBox } from '../model'
import { checkChange, checkItems, checkPages, estimateBytes, itemBytes, prepareStrokePoints, roundPoints, splitPoints, utf8Length } from './limits'

const stroke = (id: string, points: number[]): Stroke => ({ type: 'stroke', id, tool: 'pen', color: 'ink', width: 2, points })

describe('saving points', () => {
  it('rounds coordinates to 0.1 and pressure to 0.01, and clamps them', () => {
    expect(roundPoints([1.234, 5.678, 0.4567, 2e6, -3e6, 1.5])).toEqual([1.2, 5.7, 0.46, 1e6, -1e6, 1])
  })

  it('drops points that round onto the one before', () => {
    expect(roundPoints([1, 1, 0.5, 1.01, 1.02, 0.7, 2, 2, 0.5])).toEqual([1, 1, 0.7, 2, 2, 0.5])
  })

  it('splits a long stroke into parts that join up', () => {
    const points: number[] = []
    for (let i = 0; i < 12; i++) points.push(i, 0, 0.5)
    const parts = splitPoints(points, 5)
    expect(parts.map((p) => p.length / 3)).toEqual([5, 5, 4])
    expect(parts[1].slice(0, 3)).toEqual(parts[0].slice(-3))
    expect(parts.every((p) => p.length / 3 <= 5)).toBe(true)
  })

  it('keeps a short stroke in one part', () => {
    expect(splitPoints([1, 2, 0.5])).toEqual([[1, 2, 0.5]])
  })

  it('prepares a stroke within the per-stroke limit', () => {
    // A zig-zag that thinning can't simplify: 12,000 corners.
    const raw: number[] = []
    for (let i = 0; i < 12_000; i++) raw.push(i, i % 2 ? 10 : 0, 0.5)
    const parts = prepareStrokePoints(raw)
    expect(parts.length).toBe(3)
    expect(parts.every((p) => p.length / 3 <= LIMITS.pointsPerStroke && p.length % 3 === 0)).toBe(true)
    expect(prepareStrokePoints([])).toEqual([])
  })
})

describe('limits', () => {
  it('accepts a normal drawing', () => {
    expect(checkItems([stroke('a', [0, 0, 0.5])])).toBeNull()
  })

  it('refuses too many items', () => {
    const items: SketchItem[] = Array.from({ length: LIMITS.items + 1 }, (_, i) => stroke(`s${i}`, [0, 0, 0.5]))
    expect(checkItems(items)).toBe('items')
  })

  it('refuses too many points', () => {
    const big = new Array(4_999 * 3).fill(0.5)
    const items = Array.from({ length: 81 }, (_, i) => stroke(`s${i}`, big))
    expect(checkItems(items)).toBe('points')
  })

  it('refuses too much text', () => {
    const box = (i: number): TextBox => ({ type: 'text', id: `t${i}`, color: 'ink', x: 0, y: 0, size: 16, text: 'x'.repeat(2000) })
    expect(checkItems(Array.from({ length: 51 }, (_, i) => box(i)))).toBe('text')
  })

  it('refuses a file that would be too large', () => {
    // 380,000 points of long numbers: under the point limit, over 2 MB.
    const points: number[] = []
    for (let i = 0; i < 4_000 * 3; i += 3) points.push(123456.7, -234567.8, 0.55)
    const items = Array.from({ length: 95 }, (_, i) => stroke(`s${i}`, points))
    expect(estimateBytes(items)).toBeGreaterThan(LIMITS.fileBytes)
    expect(checkItems(items)).toBe('size')
  })

  it('checks the number of pages', () => {
    expect(checkPages(101)).toBe('pages')
    expect(checkPages(0)).toBe('pages')
    expect(checkPages(100)).toBeNull()
  })

  it('lets a drawing past a limit shrink, but not grow', () => {
    const items: SketchItem[] = Array.from({ length: LIMITS.items + 2 }, (_, i) => stroke(`s${i}`, [0, 0, 0.5]))
    expect(checkChange(items, items.slice(1))).toBeNull()
    expect(checkChange(items.slice(1), items)).toBe('items')
    expect(checkChange([], [stroke('a', [0, 0, 0.5])])).toBeNull()
  })

  it('counts whole numbers as the server writes them (12.0)', () => {
    const whole = stroke('a', [10, 20, 1])
    const fraction = stroke('a', [10.5, 20.5, 0.5])
    // "10.0,20.0,1.0" is as long as "10.5,20.5,0.5".
    expect(itemBytes(whole)).toBe(itemBytes(fraction))
  })

  it('counts UTF-8 bytes', () => {
    expect(utf8Length('abc')).toBe(3)
    expect(utf8Length('ї')).toBe(2)
    expect(utf8Length('€')).toBe(3)
    expect(utf8Length('😀')).toBe(4)
  })
})
