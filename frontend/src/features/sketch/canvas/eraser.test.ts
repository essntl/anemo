import type { Shape, SketchItem, Stroke } from '../model'
import { cutStroke, eraseAlong, eraseAt } from './eraser'

const line = (id: string, y: number, from = 0, to = 100): Stroke => ({ type: 'stroke', id, tool: 'pen', color: 'ink', width: 2, points: [from, y, 0.5, to, y, 0.5] })
const rect: Shape = { type: 'rect', id: 'r', color: 'ink', width: 2, x1: 200, y1: 0, x2: 300, y2: 100 }

describe('whole-stroke erasing', () => {
  it('removes what it touches and keeps the rest', () => {
    const items: SketchItem[] = [line('a', 0), line('b', 50), rect]
    const out = eraseAt(items, 50, 1, 3, 'whole')
    expect(out.map((i) => i.id)).toEqual(['b', 'r'])
    expect(eraseAt(items, 200, 50, 3, 'whole').map((i) => i.id)).toEqual(['a', 'b'])
  })

  it('gives back the same list when it touches nothing', () => {
    const items: SketchItem[] = [line('a', 0)]
    expect(eraseAt(items, 50, 40, 3, 'whole')).toBe(items)
  })

  it('leaves no gaps along a fast swipe', () => {
    const items: SketchItem[] = [line('a', 0, 40, 41), line('b', 0, 60, 61)]
    // From (0, -50) to (100, 50): crosses y = 0 at x = 50; the radius 15 reaches both.
    expect(eraseAlong(items, 0, -50, 100, 50, 15, 'whole')).toHaveLength(0)
  })
})

describe('partial erasing', () => {
  it('cuts a stroke in two where the eraser crosses its middle', () => {
    const parts = cutStroke(line('a', 0), 50, 0, 10)
    expect(parts).toHaveLength(2)
    expect(parts[0].id).toBe('a')
    expect(parts[1].id).not.toBe('a')
    // The cut ends where the circle (radius 10 + half the width) meets the line.
    expect(parts[0].points).toEqual([0, 0, 0.5, 39, 0, 0.5])
    expect(parts[1].points).toEqual([61, 0, 0.5, 100, 0, 0.5])
  })

  it('shortens a stroke at its end', () => {
    const parts = cutStroke(line('a', 0), 100, 0, 10)
    expect(parts).toHaveLength(1)
    expect(parts[0].points).toEqual([0, 0, 0.5, 89, 0, 0.5])
  })

  it('removes a stroke that is under it entirely, and keeps one it misses', () => {
    const s = line('a', 0, 0, 5)
    expect(cutStroke(s, 2, 0, 10)).toEqual([])
    expect(cutStroke(s, 2, 50, 10)[0]).toBe(s)
  })

  it('erases shapes whole', () => {
    const out = eraseAt([rect, line('a', 0)], 200, 50, 3, 'partial')
    expect(out.map((i) => i.id)).toEqual(['a'])
  })

  it('keeps the order of the items', () => {
    const out = eraseAt([line('a', 0), line('b', 50), line('c', 100)], 50, 50, 5, 'partial')
    expect(out.map((i) => i.id).slice(0, 1)).toEqual(['a'])
    expect(out[out.length - 1].id).toBe('c')
    expect(out).toHaveLength(4)
  })
})
