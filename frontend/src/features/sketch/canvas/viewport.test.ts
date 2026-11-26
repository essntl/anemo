import { emptySketch, PAGE, type Stroke } from '../model'
import { clampViewport, fitRect, fitViewport, initialViewport, MAX_ZOOM, MIN_ZOOM, toScreen, toSheet, visibleRect, zoomAt } from './viewport'

describe('viewport', () => {
  const v = { x: 30, y: -20, zoom: 2 }

  it('converts between screen and sheet', () => {
    expect(toScreen(v, 10, 10)).toEqual({ x: 50, y: 0 })
    expect(toSheet(v, 50, 0)).toEqual({ x: 10, y: 10 })
  })

  it('zooms around a point that stays put', () => {
    const before = toSheet(v, 200, 120)
    const z = zoomAt(v, 1.5, 200, 120)
    expect(z.zoom).toBe(3)
    const after = toSheet(z, 200, 120)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
  })

  it('clamps the zoom', () => {
    expect(zoomAt(v, 100, 0, 0).zoom).toBe(MAX_ZOOM)
    expect(zoomAt(v, 0.0001, 0, 0).zoom).toBe(MIN_ZOOM)
  })

  it('keeps the view within the sheet', () => {
    const far = clampViewport({ x: -1e9, y: 0, zoom: 1 }, 800, 600)
    expect(toSheet(far, 400, 300).x).toBe(1e6)
  })

  it('shows what it shows', () => {
    expect(visibleRect({ x: 0, y: 0, zoom: 2 }, 800, 600)).toEqual({ minX: 0, minY: 0, maxX: 400, maxY: 300 })
  })

  it('fits a box with padding, not zooming in past the cap', () => {
    const f = fitRect({ minX: 0, minY: 0, maxX: 1000, maxY: 500 }, 600, 400, 50)
    expect(f.zoom).toBeCloseTo(0.5)
    const centre = toSheet(f, 300, 200)
    expect(centre.x).toBeCloseTo(500)
    expect(centre.y).toBeCloseTo(250)
    expect(fitRect({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 600, 400).zoom).toBe(1)
  })

  it('opens pages across the width, and a drawing fitted', () => {
    const pages = initialViewport(emptySketch('pages'), 400, 800)
    expect(pages.zoom).toBeCloseTo((400 - 32) / PAGE.width)
    expect(pages.y).toBe(16)
    expect(initialViewport(emptySketch(), 800, 600)).toEqual({ x: 0, y: 0, zoom: 1 })
    const s: Stroke = { type: 'stroke', id: 'a', tool: 'pen', color: 'ink', width: 2, points: [5000, 5000, 0.5, 5100, 5100, 0.5] }
    const drawn = initialViewport({ ...emptySketch(), items: [s] }, 800, 600)
    const centre = toSheet(drawn, 400, 300)
    expect(centre.x).toBeCloseTo(5050)
  })

  it('fits all pages', () => {
    const f = fitViewport({ ...emptySketch('pages'), pages: 3 }, 800, 600)
    const top = toScreen(f, 0, 0)
    expect(top.y).toBeGreaterThanOrEqual(31)
  })
})
