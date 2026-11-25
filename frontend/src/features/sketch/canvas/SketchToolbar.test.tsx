import { fireEvent, render, screen } from '@testing-library/react'
import { SketchToolbar, type SketchToolbarProps } from './SketchToolbar'
import { DEFAULT_STYLE } from './toolStyle'

function setup(over: Partial<SketchToolbarProps> = {}) {
  const props: SketchToolbarProps = {
    tool: 'pen', onTool: vi.fn(), style: DEFAULT_STYLE, onStyle: vi.fn(),
    canUndo: false, canRedo: true, onUndo: vi.fn(), onRedo: vi.fn(),
    hasSelection: false, onDeleteSelection: vi.fn(),
    sheet: { layout: 'infinite', background: 'plain', pages: 1 }, onSheet: vi.fn(),
    fingerDraws: true, onFingerDraws: vi.fn(),
    ...over,
  }
  render(<SketchToolbar {...props} />)
  return props
}

describe('SketchToolbar', () => {
  it('names every tool and marks the chosen one', () => {
    const props = setup()
    expect(screen.getByRole('toolbar', { name: 'Drawing tools' })).toBeInTheDocument()
    for (const name of ['Pen', 'Highlighter', 'Eraser', 'Select', 'Shapes', 'Text', 'Move around']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    }
    expect(screen.getByRole('button', { name: 'Pen' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Pen' })).toHaveAttribute('title', 'Pen (P)')
    fireEvent.click(screen.getByRole('button', { name: 'Eraser' }))
    expect(props.onTool).toHaveBeenCalledWith('eraser')
  })

  it('picks a shape from its panel', () => {
    const props = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Shapes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ellipse' }))
    expect(props.onTool).toHaveBeenCalledWith('ellipse')
  })

  it('enables undo and redo as told', () => {
    const props = setup()
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }))
    expect(props.onRedo).toHaveBeenCalled()
  })

  it('offers to delete a selection only when there is one', () => {
    setup()
    expect(screen.queryByRole('button', { name: 'Delete what is selected' })).not.toBeInTheDocument()
  })

  it('deletes the selection', () => {
    const props = setup({ tool: 'select', hasSelection: true })
    fireEvent.click(screen.getByRole('button', { name: 'Delete what is selected' }))
    expect(props.onDeleteSelection).toHaveBeenCalled()
  })

  it('chooses a colour, your own colour and a size', () => {
    const props = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Colour and size' }))
    expect(screen.getByRole('radio', { name: 'Ink' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('radio', { name: 'Red' }))
    expect(props.onStyle).toHaveBeenLastCalledWith(expect.objectContaining({ colors: { ...DEFAULT_STYLE.colors, ink: '#e03131' } }))
    fireEvent.change(screen.getByLabelText('Your own colour'), { target: { value: '#ABCDEF' } })
    expect(props.onStyle).toHaveBeenLastCalledWith(expect.objectContaining({ colors: { ...DEFAULT_STYLE.colors, ink: '#abcdef' } }))
    fireEvent.click(screen.getByRole('radio', { name: 'Thick' }))
    expect(props.onStyle).toHaveBeenLastCalledWith(expect.objectContaining({ sizes: { ...DEFAULT_STYLE.sizes, pen: 6 } }))
  })

  it('has no colour for the eraser, but what it erases', () => {
    const props = setup({ tool: 'eraser' })
    fireEvent.click(screen.getByRole('button', { name: 'Colour and size' }))
    expect(screen.queryByRole('radio', { name: 'Ink' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Parts of strokes' }))
    expect(props.onStyle).toHaveBeenLastCalledWith(expect.objectContaining({ eraseMode: 'partial' }))
  })

  it('adds a page in the pages layout and turns drawing with a finger off', () => {
    const props = setup({ sheet: { layout: 'pages', background: 'plain', pages: 2 } })
    fireEvent.click(screen.getByRole('button', { name: 'Add a page' }))
    expect(props.onSheet).toHaveBeenCalledWith({ pages: 3 })
    fireEvent.click(screen.getByRole('button', { name: 'Sheet settings' }))
    expect(screen.getByText('2 pages')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: 'Draw with finger' }))
    expect(props.onFingerDraws).toHaveBeenCalledWith(false)
  })
})
