import { act, fireEvent, render, screen } from '@testing-library/react'
import { emptySketch, type SketchData, type Stroke } from '../model'
import { fakeContext } from './fakeContext'
import { SketchCanvas } from './SketchCanvas'

// jsdom has no canvas and lays nothing out: a fake 2D context and an 800 × 600 box.
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeContext().ctx as unknown as ReturnType<HTMLCanvasElement['getContext']>)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
  localStorage.clear()
})
afterEach(() => vi.restoreAllMocks())

const pointer = { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, isPrimary: true }

function drawLine(target: Element, from: [number, number], to: [number, number]) {
  fireEvent.pointerDown(target, { ...pointer, clientX: from[0], clientY: from[1] })
  fireEvent.pointerMove(target, { ...pointer, clientX: (from[0] + to[0]) / 2, clientY: (from[1] + to[1]) / 2 })
  fireEvent.pointerUp(target, { ...pointer, clientX: to[0], clientY: to[1] })
}

describe('SketchCanvas', () => {
  it('draws a stroke and reports the drawing once, when it ends', () => {
    const onChange = vi.fn()
    render(<SketchCanvas data={emptySketch()} onChange={onChange} />)
    const input = screen.getByTestId('sketch-input')
    fireEvent.pointerDown(input, { ...pointer, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(input, { ...pointer, clientX: 40, clientY: 30 })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.pointerUp(input, { ...pointer, clientX: 80, clientY: 60 })
    expect(onChange).toHaveBeenCalledTimes(1)
    const next: SketchData = onChange.mock.calls[0][0]
    expect(next.items).toHaveLength(1)
    const s = next.items[0] as Stroke
    expect(s).toMatchObject({ type: 'stroke', tool: 'pen', color: 'ink' })
    expect(s.points.slice(0, 2)).toEqual([10, 10])
  })

  it('undoes and redoes with the keyboard and the toolbar', () => {
    const onChange = vi.fn()
    render(<SketchCanvas data={emptySketch()} onChange={onChange} />)
    drawLine(screen.getByTestId('sketch-input'), [10, 10], [90, 90])
    const sheet = screen.getByRole('group', { name: 'Sketch' })
    fireEvent.keyDown(sheet, { key: 'z', ctrlKey: true })
    expect(onChange.mock.calls.at(-1)![0].items).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }))
    expect(onChange.mock.calls.at(-1)![0].items).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    fireEvent.keyDown(sheet, { key: 'y', ctrlKey: true })
    expect(onChange.mock.calls.at(-1)![0].items).toHaveLength(1)
  })

  it('selects with the lasso and deletes with the Delete key', () => {
    const onChange = vi.fn()
    const data: SketchData = { ...emptySketch(), items: [{ type: 'rect', id: 'r', color: 'ink', width: 2, x1: 100, y1: 100, x2: 200, y2: 150 }] }
    render(<SketchCanvas data={data} onChange={onChange} />)
    const sheet = screen.getByRole('group', { name: 'Sketch' })
    fireEvent.keyDown(sheet, { key: 'v' })
    expect(screen.getByRole('button', { name: 'Select' })).toHaveAttribute('aria-pressed', 'true')
    // The opening view fits the drawing: tap the left edge of the rectangle: at 100 % it is centred (jsdom gives the toolbar no height), so (100, 125) is at (350, 300).
    const input = screen.getByTestId('sketch-input')
    fireEvent.pointerDown(input, { ...pointer, clientX: 350, clientY: 300 })
    fireEvent.pointerUp(input, { ...pointer, clientX: 350, clientY: 300 })
    expect(screen.getByRole('button', { name: 'Delete what is selected' })).toBeInTheDocument()
    fireEvent.keyDown(sheet, { key: 'Delete' })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0].items).toEqual([])
  })

  it('places a text box, typed into a field over the canvas', () => {
    const onChange = vi.fn()
    render(<SketchCanvas data={emptySketch()} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Text' }))
    const input = screen.getByTestId('sketch-input')
    fireEvent.pointerDown(input, { ...pointer, clientX: 100, clientY: 120 })
    fireEvent.pointerUp(input, { ...pointer, clientX: 100, clientY: 120 })
    const field = screen.getByRole('textbox', { name: 'Text' })
    fireEvent.change(field, { target: { value: '<img src=x> hello' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0].items[0]).toMatchObject({ type: 'text', x: 100, y: 120, text: '<img src=x> hello', size: 24 })
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    // Never markup: nothing of the text became an element.
    expect(document.querySelector('img')).toBeNull()
  })

  it('changes the sheet from its settings', () => {
    const onChange = vi.fn()
    render(<SketchCanvas data={emptySketch()} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sheet settings' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Pages' }))
    expect(onChange.mock.calls.at(-1)![0]).toMatchObject({ layout: 'pages', pages: 1 })
    fireEvent.click(screen.getAllByRole('button', { name: 'Add a page' })[0])
    expect(onChange.mock.calls.at(-1)![0].pages).toBe(2)
    fireEvent.click(screen.getByRole('radio', { name: 'Grid' }))
    expect(onChange.mock.calls.at(-1)![0].background).toBe('grid')
  })

  it('lets a read-only sheet be moved and zoomed, not drawn on', () => {
    const onChange = vi.fn()
    render(<SketchCanvas data={emptySketch()} onChange={onChange} readOnly />)
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
    drawLine(screen.getByTestId('sketch-input'), [10, 10], [90, 90])
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /^Zoom 100%/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(screen.getByRole('button', { name: /^Zoom 125%/ })).toBeInTheDocument()
  })

  it('leaves drawing to the pen once a pen was used: a finger moves the view', () => {
    const onChange = vi.fn()
    render(<SketchCanvas data={emptySketch()} onChange={onChange} />)
    const input = screen.getByTestId('sketch-input')
    const pen = { ...pointer, pointerType: 'pen', pressure: 0.6 }
    fireEvent.pointerDown(input, { ...pen, clientX: 10, clientY: 10 })
    fireEvent.pointerUp(input, { ...pen, clientX: 50, clientY: 10 })
    expect(onChange).toHaveBeenCalledTimes(1)
    const finger = { ...pointer, pointerId: 2, pointerType: 'touch' }
    act(() => {
      fireEvent.pointerDown(input, { ...finger, clientX: 100, clientY: 100 })
      fireEvent.pointerMove(input, { ...finger, clientX: 150, clientY: 100 })
      fireEvent.pointerUp(input, { ...finger, clientX: 150, clientY: 100 })
    })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('anemo.sketch.penSeen')).toBe('1')
  })
})
