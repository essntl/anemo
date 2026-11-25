import { emptySketch, type Stroke } from '../model'
import { fakeContext, type FakeContext } from './fakeContext'
import { Painter, type PainterScene } from './painter'
import { LIGHT_THEME } from './palette'

const s: Stroke = { type: 'stroke', id: 'a', tool: 'pen', color: 'ink', width: 2, points: [0, 0, 0.5, 10, 10, 0.5] }

function setup() {
  const base = fakeContext(), top = fakeContext()
  const canvas = (f: FakeContext) => ({ width: 0, height: 0, getContext: () => f.ctx }) as unknown as HTMLCanvasElement
  const frames: (() => void)[] = []
  const painter = new Painter(canvas(base), canvas(top), (run) => frames.push(run), () => {})
  const runFrame = () => frames.splice(0).forEach((run) => run())
  return { base, top, painter, frames, runFrame }
}

const scene = (over: Partial<PainterScene> = {}): PainterScene => ({
  data: emptySketch(), items: [s], view: { x: 0, y: 0, zoom: 1 }, theme: LIGHT_THEME, hidden: null, ...over,
})

describe('the painter', () => {
  it('waits for a frame and draws many changes once', () => {
    const { base, painter, frames, runFrame } = setup()
    painter.resize(100, 100, 2)
    painter.setScene(scene())
    painter.setScene(scene({ view: { x: 5, y: 0, zoom: 1 } }))
    expect(frames).toHaveLength(1)
    expect(base.count('fill')).toBe(0)
    runFrame()
    expect(base.count('fill')).toBe(1)
    expect(painter.lastDrawn).toBe(1)
  })

  it('draws only the top layer when only it changed', () => {
    const { base, top, painter, runFrame } = setup()
    painter.resize(100, 100, 1)
    painter.setScene(scene())
    runFrame()
    base.reset()
    top.reset()
    const overlay = vi.fn()
    painter.setOverlay(overlay)
    runFrame()
    expect(overlay).toHaveBeenCalledTimes(1)
    expect(base.calls).toHaveLength(0)
    expect(top.count('clearRect')).toBe(1)
  })

  it('does not draw the drawing again for the same scene', () => {
    const { base, painter, frames, runFrame } = setup()
    painter.resize(100, 100, 1)
    const same = scene()
    painter.setScene(same)
    runFrame()
    base.reset()
    painter.setScene({ ...same })
    expect(frames).toHaveLength(0)
    expect(base.calls).toHaveLength(0)
  })

  it('leaves hidden items to the top layer', () => {
    const { painter, runFrame } = setup()
    painter.resize(100, 100, 1)
    painter.setScene(scene({ hidden: new Set(['a']) }))
    runFrame()
    expect(painter.lastDrawn).toBe(0)
  })
})
