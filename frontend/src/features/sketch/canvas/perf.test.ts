/**
 * A drawing at the size the server allows (thousands of thinned-out pen strokes): the
 * work done per pointer move or per frame must stay quick. The bounds are generous
 * (slow CI machines); the times measured are printed for reference.
 */
import type { Stroke } from '../model'
import { eraseAt } from './eraser'
import { fakeContext } from './fakeContext'
import { itemBounds, topItemAt } from './geometry'
import { selectInLasso } from './lasso'
import { checkItems } from './limits'
import { LIGHT_THEME } from './palette'
import { drawItems, drawScene } from './render'

const STROKES = 5_000
const POINTS = 30

function bigSheet(): Stroke[] {
  let seed = 7
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const strokes: Stroke[] = []
  for (let s = 0; s < STROKES; s++) {
    // Strokes spread over a 4,000 × 4,000 sheet, each a short wiggle.
    const x0 = random() * 4000, y0 = random() * 4000
    const points: number[] = []
    for (let i = 0; i < POINTS; i++) points.push(Math.round((x0 + i * 3) * 10) / 10, Math.round((y0 + Math.sin(i / 3) * 8) * 10) / 10, 0.5)
    strokes.push({ type: 'stroke', id: `s${s}`, tool: 'pen', color: 'ink', width: 3, points })
  }
  return strokes
}

const time = (run: () => void): number => {
  const start = performance.now()
  run()
  return performance.now() - start
}

describe(`a sheet of ${STROKES} strokes × ${POINTS} points`, () => {
  const items = bigSheet()
  const measured: Record<string, number> = {}

  afterAll(() => {
    console.info('sketch perf (ms):', Object.fromEntries(Object.entries(measured).map(([k, v]) => [k, Math.round(v * 100) / 100])))
  })

  it('checks the limits quickly (this many is past the 2 MB a file may have)', () => {
    measured.checkLimits = time(() => expect(checkItems(items)).toBe('size'))
    expect(measured.checkLimits).toBeLessThan(500)
  })

  it('builds the bounds of every item quickly', () => {
    measured.bounds = time(() => items.forEach(itemBounds))
    expect(measured.bounds).toBeLessThan(500)
  })

  it('hit-tests a tap quickly', () => {
    measured.hitTest = time(() => {
      for (let i = 0; i < 100; i++) topItemAt(items, i * 40, i * 40, 4)
    }) / 100
    expect(measured.hitTest).toBeLessThan(20)
  })

  it('erases at a point quickly (one pointer move)', () => {
    measured.eraseWhole = time(() => {
      for (let i = 0; i < 100; i++) eraseAt(items, i * 40, 2000, 14, 'whole')
    }) / 100
    measured.erasePartial = time(() => {
      for (let i = 0; i < 100; i++) eraseAt(items, i * 40, 2000, 14, 'partial')
    }) / 100
    expect(measured.eraseWhole).toBeLessThan(20)
    expect(measured.erasePartial).toBeLessThan(20)
  })

  it('selects with a large lasso quickly', () => {
    const lasso: number[] = []
    for (let i = 0; i < 400; i++) {
      const a = (i / 400) * Math.PI * 2
      lasso.push(2000 + Math.cos(a) * 1500, 2000 + Math.sin(a) * 1500)
    }
    let chosen: string[] = []
    measured.lasso = time(() => {
      chosen = selectInLasso(items, lasso)
    })
    expect(chosen.length).toBeGreaterThan(STROKES * 0.3)
    expect(measured.lasso).toBeLessThan(1000)
  })

  it('renders everything into a context, and then a view of a part of it', () => {
    const f = fakeContext()
    measured.renderAllFirst = time(() => drawItems(f.ctx, items, LIGHT_THEME))
    expect(f.count('fill')).toBe(STROKES)
    f.reset()
    // Again: the outlines are cached now.
    measured.renderAllCached = time(() => drawItems(f.ctx, items, LIGHT_THEME))
    f.reset()
    let drawn = 0
    measured.renderViewport = time(() => {
      drawn = drawScene(f.ctx, { data: { layout: 'infinite', background: 'grid', pages: 1 }, items, view: { x: 0, y: 0, zoom: 1 }, width: 1200, height: 800, dpr: 2, theme: LIGHT_THEME })
    })
    expect(drawn).toBeGreaterThan(0)
    expect(drawn).toBeLessThan(STROKES / 5)
    expect(measured.renderAllFirst).toBeLessThan(5000)
    expect(measured.renderViewport).toBeLessThan(200)
  })
})
