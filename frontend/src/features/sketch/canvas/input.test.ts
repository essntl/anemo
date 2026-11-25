import { fingerDraws, inkPressure, pinchViewport, pointerRole, wheelViewport, type PointerDecision } from './input'
import { toSheet } from './viewport'

const decide = (over: Partial<PointerDecision>) =>
  pointerRole({ pointerType: 'mouse', button: 0, penSeen: false, fingerSetting: null, panning: false, readOnly: false, ...over })

describe('palm rejection', () => {
  it('lets fingers draw until a pen is seen', () => {
    expect(fingerDraws(false, null)).toBe(true)
    expect(fingerDraws(true, null)).toBe(false)
  })

  it('follows "Draw with finger" when it is chosen', () => {
    expect(fingerDraws(true, true)).toBe(true)
    expect(fingerDraws(false, false)).toBe(false)
  })

  it('decides what a pointer does', () => {
    expect(decide({ pointerType: 'pen' })).toBe('draw')
    expect(decide({ pointerType: 'mouse' })).toBe('draw')
    expect(decide({ pointerType: 'touch' })).toBe('draw')
    expect(decide({ pointerType: 'touch', penSeen: true })).toBe('pan')
    expect(decide({ pointerType: 'pen', penSeen: true })).toBe('draw')
    expect(decide({ pointerType: 'touch', penSeen: true, fingerSetting: true })).toBe('draw')
  })

  it('pans with the hand tool, Space, the middle button and when read-only', () => {
    expect(decide({ panning: true })).toBe('pan')
    expect(decide({ button: 1 })).toBe('pan')
    expect(decide({ readOnly: true, pointerType: 'pen' })).toBe('pan')
    expect(decide({ button: 2 })).toBe('ignore')
  })
})

describe('pressure', () => {
  it('is steady for a mouse and a finger', () => {
    expect(inkPressure({ pointerType: 'mouse', pressure: 0 }, null)).toBe(0.5)
    expect(inkPressure({ pointerType: 'mouse', pressure: 0.5 }, 0.2)).toBe(0.5)
    expect(inkPressure({ pointerType: 'touch', pressure: 1 }, null)).toBe(0.5)
  })

  it('reads a pen, and keeps the last pressure when it reports none', () => {
    expect(inkPressure({ pointerType: 'pen', pressure: 0.8 }, null)).toBe(0.8)
    expect(inkPressure({ pointerType: 'pen', pressure: 0 }, 0.3)).toBe(0.3)
    expect(inkPressure({ pointerType: 'pen', pressure: 0 }, null)).toBe(0.5)
  })

  it('draws a little heavier with the pen tilted', () => {
    const flat = inkPressure({ pointerType: 'pen', pressure: 0.4, tiltX: 60, tiltY: 0 }, null)
    expect(flat).toBeGreaterThan(0.4)
    expect(inkPressure({ pointerType: 'pen', pressure: 1, tiltX: 80, tiltY: 0 }, null)).toBe(1)
  })
})

describe('gestures', () => {
  const view = { x: 0, y: 0, zoom: 1 }

  it('pinches: zooms by the spread and keeps the point under the fingers', () => {
    const start = { view, a: { x: 100, y: 100 }, b: { x: 200, y: 100 } }
    const v = pinchViewport(start, { x: 50, y: 100 }, { x: 250, y: 100 })
    expect(v.zoom).toBeCloseTo(2)
    const mid = toSheet(v, 150, 100)
    expect(mid.x).toBeCloseTo(150)
    expect(mid.y).toBeCloseTo(100)
  })

  it('pans with two fingers moving together', () => {
    const start = { view, a: { x: 100, y: 100 }, b: { x: 200, y: 100 } }
    const v = pinchViewport(start, { x: 130, y: 140 }, { x: 230, y: 140 })
    expect(v).toEqual({ zoom: 1, x: 30, y: 40 })
  })

  const wheel = { deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false }

  it('scrolls with the wheel', () => {
    expect(wheelViewport(view, { ...wheel, deltaX: 10, deltaY: 30 }, 0, 0)).toEqual({ x: -10, y: -30, zoom: 1 })
    expect(wheelViewport(view, { ...wheel, deltaY: 3, deltaMode: 1 }, 0, 0).y).toBe(-48)
    expect(wheelViewport(view, { ...wheel, deltaY: 20, shiftKey: true }, 0, 0)).toEqual({ x: -20, y: 0, zoom: 1 })
  })

  it('zooms at the cursor with Ctrl (and a trackpad pinch)', () => {
    const v = wheelViewport(view, { ...wheel, deltaY: -10, ctrlKey: true }, 300, 200)
    expect(v.zoom).toBeGreaterThan(1)
    const p = toSheet(v, 300, 200)
    expect(p.x).toBeCloseTo(300)
    expect(p.y).toBeCloseTo(200)
    // A mouse wheel notch with Ctrl (100 px) zooms one sensible step, not a jump.
    expect(wheelViewport(view, { ...wheel, deltaY: 100, metaKey: true }, 0, 0).zoom).toBeCloseTo(Math.exp(-0.6))
  })
})
