import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Segmented } from './Segmented'
import { Slider } from './Slider'

describe('Slider', () => {
  it('describes itself to screen readers', () => {
    render(<Slider label="Volume" value={0.5} onChange={() => {}} valueText={(v) => `${Math.round(v * 100)}%`} />)
    const slider = screen.getByRole('slider', { name: 'Volume' })
    expect(slider).toHaveAttribute('aria-valuenow', '0.5')
    expect(slider).toHaveAttribute('aria-valuetext', '50%')
    expect(slider).toHaveAttribute('aria-valuemin', '0')
    expect(slider).toHaveAttribute('aria-valuemax', '1')
  })

  it('moves with the keyboard, clamped to its range', () => {
    const onChange = vi.fn()
    render(<Slider label="Seek" value={10} min={0} max={100} step={1} onChange={onChange} />)
    const slider = screen.getByRole('slider')
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    fireEvent.keyDown(slider, { key: 'ArrowLeft' })
    fireEvent.keyDown(slider, { key: 'PageUp' })
    fireEvent.keyDown(slider, { key: 'End' })
    fireEvent.keyDown(slider, { key: 'Home' })
    expect(onChange.mock.calls.map((c) => c[0])).toEqual([11, 9, 20, 100, 0])
  })

  it('ignores keys when disabled', () => {
    const onChange = vi.fn()
    render(<Slider label="Seek" value={1} onChange={onChange} disabled />)
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowRight' })
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('slider')).toHaveAttribute('aria-disabled', 'true')
  })
})

function Phases() {
  const [value, setValue] = useState<'focus' | 'short' | 'long'>('focus')
  return (
    <Segmented
      label="Timer phase"
      value={value}
      onChange={setValue}
      options={[
        { value: 'focus', label: 'Focus' },
        { value: 'short', label: 'Short break' },
        { value: 'long', label: 'Long break' },
      ]}
    />
  )
}

describe('Segmented', () => {
  it('is one radio group with one tab stop', () => {
    render(<Phases />)
    expect(screen.getByRole('radiogroup', { name: 'Timer phase' })).toBeInTheDocument()
    const radios = screen.getAllByRole('radio')
    expect(radios.map((r) => r.getAttribute('tabindex'))).toEqual(['0', '-1', '-1'])
    expect(radios[0]).toHaveAttribute('aria-checked', 'true')
  })

  it('selects with clicks and arrow keys, wrapping around', async () => {
    render(<Phases />)
    await userEvent.click(screen.getByRole('radio', { name: 'Short break' }))
    expect(screen.getByRole('radio', { name: 'Short break' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Short break' }), { key: 'ArrowRight' })
    expect(screen.getByRole('radio', { name: 'Long break' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Long break' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Long break' }), { key: 'ArrowRight' })
    expect(screen.getByRole('radio', { name: 'Focus' })).toHaveAttribute('aria-checked', 'true')
  })

  it('can be tabs that point at their panels', () => {
    render(
      <Segmented label="Music" kind="tabs" controls="music" value="queue" onChange={() => {}}
        options={[{ value: 'queue', label: 'Queue' }, { value: 'playlists', label: 'Playlists' }]} />,
    )
    const tab = screen.getByRole('tab', { name: 'Queue' })
    expect(tab).toHaveAttribute('aria-selected', 'true')
    expect(tab).toHaveAttribute('aria-controls', 'music-queue')
  })
})
