import { emptySketch, type Shape, type SketchItem, type Stroke, type TextBox } from '../model'
import { fakeContext } from './fakeContext'
import { LIGHT_THEME } from './palette'
import { drawItems, drawScene, drawText, patternStep, strokeOutline } from './render'

const pen = (id: string, x: number, color = 'ink'): Stroke => ({ type: 'stroke', id, tool: 'pen', color, width: 3, points: [x, 0, 0.5, x + 10, 5, 0.6, x + 20, 0, 0.5] })
const marker = (id: string): Stroke => ({ ...pen(id, 0, '#f5c400'), tool: 'highlighter', width: 18 })
const rect: Shape = { type: 'rect', id: 'r', color: '#e03131', width: 2, x1: 0, y1: 0, x2: 50, y2: 30 }
const arrow: Shape = { ...rect, id: 'a', type: 'arrow' }

describe('drawing items', () => {
  it('fills pen strokes in the resolved ink', () => {
    const f = fakeContext()
    drawItems(f.ctx, [pen('a', 0)], LIGHT_THEME)
    expect(f.count('fill')).toBe(1)
    expect(f.ctx.fillStyle).toBe(LIGHT_THEME.ink)
  })

  it('draws highlighter strokes first, under the rest', () => {
    const f = fakeContext()
    const order: string[] = []
    const items: SketchItem[] = [pen('a', 0, '#000001'), marker('m'), pen('b', 40, '#000002')]
    const ctx = new Proxy(f.ctx, {
      get(target, prop) {
        if (prop === 'fill') return () => order.push(String(target.fillStyle))
        return Reflect.get(target, prop)
      },
    })
    drawItems(ctx, items, LIGHT_THEME)
    expect(order).toEqual(['#f5c400', '#000001', '#000002'])
  })

  it('draws shapes with lines, and an arrow with its head', () => {
    const f = fakeContext()
    drawItems(f.ctx, [rect], LIGHT_THEME)
    expect(f.count('rect')).toBe(1)
    expect(f.count('stroke')).toBe(1)
    f.reset()
    drawItems(f.ctx, [arrow], LIGHT_THEME)
    expect(f.count('lineTo')).toBe(3)
  })

  it('draws text with fillText, line by line', () => {
    const f = fakeContext()
    const box: TextBox = { type: 'text', id: 't', color: 'ink', x: 10, y: 10, size: 20, text: '<b>not markup</b>\nsecond line' }
    drawText(f.ctx, box, LIGHT_THEME)
    const texts = f.calls.filter((c) => c.name === 'fillText').map((c) => c.args[0])
    expect(texts).toEqual(['<b>not markup</b>', 'second line'])
  })

  it('skips items outside the visible area and hidden ones', () => {
    const f = fakeContext()
    const items = [pen('near', 0), pen('far', 5000), pen('hidden', 10)]
    const drawn = drawItems(f.ctx, items, LIGHT_THEME, { visible: { minX: -10, minY: -10, maxX: 100, maxY: 100 }, hidden: new Set(['hidden']) })
    expect(drawn).toBe(1)
  })

  it('outlines a single point as a dot', () => {
    expect(strokeOutline('pen', 4, [10, 10, 0.5]).length).toBeGreaterThan(3)
  })

  it('uses Path2D, kept per stroke, where the browser has it', () => {
    const made: unknown[] = []
    class FakePath {
      constructor() {
        made.push(this)
      }
      moveTo() {}
      quadraticCurveTo() {}
      closePath() {}
    }
    vi.stubGlobal('Path2D', FakePath)
    try {
      const s = pen('cached', 0)
      const f = fakeContext()
      drawItems(f.ctx, [s], LIGHT_THEME)
      drawItems(f.ctx, [s], LIGHT_THEME)
      expect(made).toHaveLength(1)
      expect(f.calls.filter((c) => c.name === 'fill').every((c) => c.args[0] === made[0])).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('the paper', () => {
  it('draws the pattern only where it can be seen', () => {
    expect(patternStep('grid', 1)).toBe(24)
    expect(patternStep('grid', 0.1)).toBe(96)
    expect(patternStep('lines', 1)).toBe(32)
  })

  it('draws a scene: paper, grid and items', () => {
    const f = fakeContext()
    const n = drawScene(f.ctx, {
      data: { ...emptySketch(), background: 'grid' }, items: [pen('a', 0)], view: { x: 0, y: 0, zoom: 1 },
      width: 240, height: 120, dpr: 2, theme: LIGHT_THEME,
    })
    expect(n).toBe(1)
    expect(f.calls.find((c) => c.name === 'setTransform' && c.args[0] === 2)).toBeTruthy()
    // 240 / 24 + 1 vertical lines, 120 / 24 + 1 horizontal ones.
    expect(f.count('moveTo')).toBeGreaterThanOrEqual(11 + 6)
  })

  it('draws the pages that can be seen, each with its outline', () => {
    const f = fakeContext()
    drawScene(f.ctx, {
      data: { ...emptySketch('pages'), pages: 5 }, items: [], view: { x: 0, y: 0, zoom: 1 },
      width: 800, height: 1200, dpr: 1, theme: LIGHT_THEME,
    })
    expect(f.count('strokeRect')).toBe(2)
  })
})
