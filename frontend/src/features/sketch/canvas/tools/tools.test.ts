import { emptySketch, type SketchData, type SketchItem, type Stroke, type TextBox } from '../../model'
import { checkItems } from '../limits'
import { TOOLS, type ToolHost, type ToolPoint } from './index'
import { constrainEnd } from './shape'

const at = (x: number, y: number, shift = false, pressure = 0.5): ToolPoint => ({ x, y, pressure, shift })

/** A host like the canvas's, recording what the tools do. */
function host(items: SketchItem[] = [], over: Partial<ToolHost> = {}) {
  let data: SketchData = { ...emptySketch(), items }
  const log = { commits: [] as SketchItem[][], previews: [] as (readonly SketchItem[] | null)[], selected: [] as string[][], hidden: [] as (ReadonlySet<string> | null)[], texts: [] as unknown[] }
  const h: ToolHost = {
    get data() {
      return data
    },
    zoom: 1, color: 'ink', width: 3, eraseMode: 'whole', selection: new Set(),
    commit(next) {
      if (checkItems(next)) return false
      data = { ...data, items: next }
      log.commits.push(next)
      return true
    },
    preview: (p) => log.previews.push(p),
    select: (ids) => log.selected.push([...ids]),
    hide: (ids) => log.hidden.push(ids),
    editText: (target) => log.texts.push(target),
    ...over,
  }
  return { h, log, data: () => data }
}

const line = (id: string, y: number): Stroke => ({ type: 'stroke', id, tool: 'pen', color: 'ink', width: 2, points: [0, y, 0.5, 100, y, 0.5] })

describe('pen and highlighter', () => {
  it('commits one stroke when the pointer lifts, not before', () => {
    const { h, log, data } = host()
    const session = TOOLS.pen(h, at(0, 0, false, 0.3))!
    session.move([at(10, 1, false, 0.5), at(20, 4, false, 0.7)])
    expect(log.commits).toHaveLength(0)
    session.end(at(30, 9, false, 0.6))
    expect(log.commits).toHaveLength(1)
    const s = data().items[0] as Stroke
    expect(s).toMatchObject({ type: 'stroke', tool: 'pen', color: 'ink', width: 3 })
    expect(s.points.length % 3).toBe(0)
    expect(s.points.slice(0, 3)).toEqual([0, 0, 0.3])
  })

  it('draws the highlighter without pressure', () => {
    const { h, data } = host()
    const session = TOOLS.highlighter(h, at(0, 0, false, 0.9))!
    session.end(at(50, 50, false, 0.1))
    const s = data().items[0] as Stroke
    expect(s.tool).toBe('highlighter')
    expect(s.points.filter((_, i) => i % 3 === 2).every((p) => p === 0.5)).toBe(true)
  })

  it('makes a tap a dot', () => {
    const { h, data } = host()
    TOOLS.pen(h, at(5, 5))!.end(at(5, 5))
    expect((data().items[0] as Stroke).points).toEqual([5, 5, 0.5])
  })
})

describe('shapes', () => {
  it('draws a rectangle by dragging, and ignores a tap', () => {
    const { h, data, log } = host()
    TOOLS.rect(h, at(10, 10))!.end(at(60.04, 40))
    expect(data().items[0]).toMatchObject({ type: 'rect', x1: 10, y1: 10, x2: 60, y2: 40 })
    TOOLS.rect(h, at(10, 10))!.end(at(10.5, 10.5))
    expect(log.commits).toHaveLength(1)
  })

  it('keeps a square and 45° lines with Shift', () => {
    expect(constrainEnd('rect', 0, 0, 30, -10)).toEqual({ x: 30, y: -30 })
    expect(constrainEnd('ellipse', 0, 0, -5, 20)).toEqual({ x: -20, y: 20 })
    expect(constrainEnd('line', 0, 0, 100, 8)).toEqual({ x: 100.319, y: 0 })
    const diag = constrainEnd('arrow', 0, 0, 100, 90)
    expect(diag.x).toBeCloseTo(diag.y)
    const { h, data } = host()
    TOOLS.line(h, at(0, 0))!.end(at(50, 3, true))
    expect(data().items[0]).toMatchObject({ type: 'line', y2: 0 })
  })
})

describe('eraser', () => {
  it('shows what it erases while dragging and commits once', () => {
    const { h, log, data } = host([line('a', 0), line('b', 50)])
    const session = TOOLS.eraser(h, at(50, 100))!
    session.move([at(50, 60), at(50, 45)])
    expect(log.previews.at(-1)?.map((i) => i.id)).toEqual(['a'])
    expect(log.commits).toHaveLength(0)
    session.end(at(50, 45))
    expect(log.commits).toHaveLength(1)
    expect(data().items.map((i) => i.id)).toEqual(['a'])
  })

  it('cuts strokes in partial mode', () => {
    const { h, data } = host([line('a', 0)], { eraseMode: 'partial', width: 10 })
    TOOLS.eraser(h, at(50, 0))!.end(at(50, 0))
    expect(data().items).toHaveLength(2)
  })

  it('commits nothing when it touched nothing', () => {
    const { h, log } = host([line('a', 0)])
    TOOLS.eraser(h, at(50, 300))!.end(at(50, 300))
    expect(log.commits).toHaveLength(0)
  })
})

describe('selection', () => {
  it('selects what the lasso goes round', () => {
    const { h, log } = host([line('a', 0), line('b', 500)])
    const session = TOOLS.select(h, at(-20, -20))!
    session.move([at(150, -20), at(150, 30), at(-20, 30)])
    session.end(at(-20, -20))
    expect(log.selected.at(-1)).toEqual(['a'])
  })

  it('selects the item under a tap', () => {
    const { h, log } = host([line('a', 0)])
    // A tap on an item chooses it and starts a move that goes nowhere.
    TOOLS.select(h, at(50, 1))!.end(at(50, 1))
    expect(log.selected.at(-1)).toEqual(['a'])
    expect(log.commits).toHaveLength(0)
  })

  it('moves the selection, hiding it from the drawing layer meanwhile', () => {
    const { h, log, data } = host([line('a', 0), line('b', 500)], { selection: new Set(['a']) })
    const session = TOOLS.select(h, at(50, 0))!
    expect(log.hidden.at(-1)).toEqual(new Set(['a']))
    session.move([at(60, 20)])
    session.end(at(70, 30))
    expect(log.hidden.at(-1)).toBeNull()
    expect((data().items[0] as Stroke).points).toEqual([20, 30, 0.5, 120, 30, 0.5])
    expect((data().items[1] as Stroke).points).toEqual(line('b', 500).points)
  })

  it('resizes the selection from a corner handle', () => {
    const { h, data } = host([line('a', 0)], { selection: new Set(['a']) })
    // The frame is the stroke's box (0..100 × -1..1) with 4 px of room: its se corner is (104, 5).
    TOOLS.select(h, at(104, 5))!.end(at(208, 9))
    const s = data().items[0] as Stroke
    expect(s.points[3]).toBeGreaterThan(190)
    expect(s.width).toBeGreaterThan(2)
  })
})

describe('text', () => {
  it('starts a new text box where you tap', () => {
    const { h, log } = host()
    TOOLS.text(h, at(30, 40))!.end(at(30, 40))
    expect(log.texts).toEqual([{ x: 30, y: 40 }])
  })

  it('edits the text box you tap', () => {
    const box: TextBox = { type: 'text', id: 't', color: 'ink', x: 0, y: 0, size: 20, text: 'Hello' }
    const { h, log } = host([box])
    TOOLS.text(h, at(10, 10))!.end(at(10, 10))
    expect(log.texts).toEqual([box])
  })
})
