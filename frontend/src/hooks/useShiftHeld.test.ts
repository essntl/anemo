import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useShiftHeld } from './useShiftHeld'

const key = (type: 'keydown' | 'keyup', target: EventTarget = window) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent(type, { key: 'Shift', bubbles: true }))
  })

describe('useShiftHeld', () => {
  it('is true while Shift is held, and resets when the window loses focus', () => {
    const { result } = renderHook(() => useShiftHeld())
    expect(result.current).toBe(false)
    key('keydown')
    expect(result.current).toBe(true)
    key('keyup')
    expect(result.current).toBe(false)
    key('keydown')
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    expect(result.current).toBe(false)
  })

  it('ignores Shift pressed while typing in a text box', () => {
    const { result } = renderHook(() => useShiftHeld())
    const box = document.createElement('textarea')
    document.body.append(box)
    key('keydown', box)
    expect(result.current).toBe(false)
    box.remove()
  })
})
