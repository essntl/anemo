import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EffortSlider } from './EffortSlider'

beforeEach(() => {
  // jsdom has no layout or pointer capture: a 400px track, captured while pressed.
  Element.prototype.getBoundingClientRect = () => ({ left: 0, width: 400, top: 0, height: 10, right: 400, bottom: 10, x: 0, y: 0, toJSON: () => ({}) })
  let captured = false
  Element.prototype.setPointerCapture = () => { captured = true }
  Element.prototype.hasPointerCapture = () => captured
  Element.prototype.releasePointerCapture = () => { captured = false }
})

describe('EffortSlider', () => {
  it('is a slider over the five levels that says the level and what it means', () => {
    render(<EffortSlider value="high" onChange={() => {}} />)
    const slider = screen.getByRole('slider', { name: 'Reasoning effort' })
    expect(slider).toHaveAttribute('aria-valuemin', '0')
    expect(slider).toHaveAttribute('aria-valuemax', '4')
    expect(slider).toHaveAttribute('aria-valuenow', '3')
    expect(slider).toHaveAttribute('aria-valuetext', 'High: Thinks long and carefully')
    // The effects follow the level (styles in app.css).
    expect(slider).toHaveAttribute('data-level', 'high')
  })

  it('steps with the keyboard and stops at the ends', async () => {
    const onChange = vi.fn()
    const { rerender } = render(<EffortSlider value="medium" onChange={onChange} />)
    const slider = screen.getByRole('slider')
    slider.focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(onChange).toHaveBeenLastCalledWith('high')
    await userEvent.keyboard('{ArrowLeft}')
    expect(onChange).toHaveBeenLastCalledWith('low')
    await userEvent.keyboard('{End}')
    expect(onChange).toHaveBeenLastCalledWith('max')
    await userEvent.keyboard('{Home}')
    expect(onChange).toHaveBeenLastCalledWith('off')

    onChange.mockClear()
    rerender(<EffortSlider value="max" onChange={onChange} />)
    await userEvent.keyboard('{ArrowRight}{End}{PageUp}')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('shows a drag as it goes and reports it once, when let go', () => {
    const onChange = vi.fn()
    render(<EffortSlider value="off" onChange={onChange} />)
    const slider = screen.getByRole('slider')
    fireEvent.pointerDown(slider, { button: 0, pointerId: 1, clientX: 110 })
    expect(slider).toHaveAttribute('aria-valuenow', '1')
    fireEvent.pointerMove(slider, { pointerId: 1, clientX: 390 })
    expect(slider).toHaveAttribute('aria-valuenow', '4')
    expect(slider).toHaveAttribute('data-level', 'max')
    expect(slider).toHaveAttribute('data-dragging', 'true')
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.pointerUp(slider, { pointerId: 1 })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('max')
  })

  it('reports nothing for a tap on the level it is already at', () => {
    const onChange = vi.fn()
    render(<EffortSlider value="medium" onChange={onChange} />)
    const slider = screen.getByRole('slider')
    fireEvent.pointerDown(slider, { button: 0, pointerId: 1, clientX: 205 })
    fireEvent.pointerUp(slider, { pointerId: 1 })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('does nothing while disabled', async () => {
    const onChange = vi.fn()
    render(<EffortSlider value="low" onChange={onChange} disabled />)
    const slider = screen.getByRole('slider')
    expect(slider).toHaveAttribute('aria-disabled', 'true')
    fireEvent.keyDown(slider, { key: 'End' })
    fireEvent.pointerDown(slider, { button: 0, pointerId: 1, clientX: 390 })
    fireEvent.pointerUp(slider, { pointerId: 1 })
    expect(onChange).not.toHaveBeenCalled()
  })
})
