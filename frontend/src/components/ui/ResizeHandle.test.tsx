import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useResizableWidth } from '@/hooks/useResizableWidth'
import { ResizeHandle } from './ResizeHandle'

const KEY = 'anemo.test.width'

function Panel() {
  const size = useResizableWidth(KEY, { initial: 240, min: 200, max: 480 })
  return <div style={{ width: size.width }}><ResizeHandle size={size} label="Width" /></div>
}

describe('a panel that can be resized', () => {
  beforeEach(() => localStorage.clear())

  it('drags wider and narrower, within its limits, and remembers the width', () => {
    render(<Panel />)
    const handle = screen.getByRole('separator', { name: 'Width' })
    handle.setPointerCapture = () => {}
    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 160, pointerId: 1 })
    expect(handle).toHaveAttribute('aria-valuenow', '300')
    expect(localStorage.getItem(KEY)).toBeNull() // only once it is let go
    fireEvent.pointerUp(handle, { clientX: 1000, pointerId: 1 })
    expect(handle).toHaveAttribute('aria-valuenow', '480')
    expect(localStorage.getItem(KEY)).toBe('480')
  })

  it('moves with the arrow keys and goes back to the default on a double-click', () => {
    localStorage.setItem(KEY, '100') // below the minimum: kept to it
    render(<Panel />)
    const handle = screen.getByRole('separator', { name: 'Width' })
    expect(handle).toHaveAttribute('aria-valuenow', '200')
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(handle).toHaveAttribute('aria-valuenow', '216')
    fireEvent.doubleClick(handle)
    expect(handle).toHaveAttribute('aria-valuenow', '240')
    expect(localStorage.getItem(KEY)).toBeNull()
  })
})
