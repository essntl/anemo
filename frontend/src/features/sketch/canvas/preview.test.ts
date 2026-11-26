import { emptySketch, PAGE, pagesHeight, type SketchData, type Stroke } from '../model'
import { fakeContext } from './fakeContext'
import { BLANK_SIZE, previewLayout, renderPreview } from './preview'

const stroke = (x1: number, y1: number, x2: number, y2: number): Stroke => ({ type: 'stroke', id: 's', tool: 'pen', color: 'ink', width: 2, points: [x1, y1, 0.5, x2, y2, 0.5] })
const sheet = (over: Partial<SketchData> = {}): SketchData => ({ ...emptySketch(), ...over })

describe('preview size', () => {
  it('is a small blank image for an empty sheet', () => {
    expect(previewLayout(sheet())).toMatchObject({ area: null, ...BLANK_SIZE })
  })

  it('shows the drawing with a margin, its long side at most maxEdge', () => {
    const l = previewLayout(sheet({ items: [stroke(0, 0, 4000, 1000)] }))
    expect(Math.max(l.width, l.height)).toBe(1600)
    expect(l.area!.minX).toBeLessThan(0)
    expect(l.width / l.height).toBeCloseTo(l.area ? (l.area.maxX - l.area.minX) / (l.area.maxY - l.area.minY) : 0, 1)
  })

  it('enlarges a small doodle only a little', () => {
    const l = previewLayout(sheet({ items: [stroke(0, 0, 50, 50)] }))
    expect(l.scale).toBe(2)
    expect(l.width).toBeLessThan(250)
  })

  it('never goes past 4096 px', () => {
    const l = previewLayout(sheet({ items: [stroke(0, 0, 100_000, 10)] }), 10_000)
    expect(l.width).toBe(4096)
  })

  it('shows all pages for the pages layout', () => {
    const l = previewLayout(sheet({ layout: 'pages', pages: 3 }))
    expect(l.area).toEqual({ minX: 0, minY: 0, maxX: PAGE.width, maxY: pagesHeight(3) })
    expect(l.height).toBe(1600)
  })
})

describe('renderPreview', () => {
  afterEach(() => vi.restoreAllMocks())

  it('draws in the light theme on white and gives a PNG', async () => {
    const f = fakeContext()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(f.ctx as unknown as ReturnType<HTMLCanvasElement['getContext']>)
    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, done: BlobCallback, type?: string) {
      done(new Blob([`${this.width}x${this.height}`], { type }))
    })
    const blob = await renderPreview(sheet({ items: [stroke(0, 0, 300, 200)] }), { maxEdge: 400 })
    expect(blob.type).toBe('image/png')
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png')
    expect(await blob.text()).toMatch(/^400x\d+$/)
    // Ink is the light theme's dark text colour.
    expect(f.calls.some((c) => c.name === 'fill')).toBe(true)
    expect(f.ctx.fillStyle).toBe('#15171c')
  })

  it('gives a blank image for an empty sheet', async () => {
    const f = fakeContext()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(f.ctx as unknown as ReturnType<HTMLCanvasElement['getContext']>)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, done: BlobCallback, type?: string) {
      done(new Blob([`${this.width}x${this.height}`], { type }))
    })
    expect(await (await renderPreview(sheet())).text()).toBe('400x300')
    expect(f.ctx.fillStyle).toBe('#ffffff')
  })
})
