import { useEffect, useState } from 'react'
import { isTyping } from './useHotkey'

/**
 * True while Shift is held down (and not while typing in a field, where Shift only
 * makes capital letters). Resets when the window loses focus, since the key-up then
 * never arrives.
 */
export function useShiftHeld(): boolean {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Shift' && !e.repeat && !isTyping(e.target)) setHeld(true)
    }
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setHeld(false)
    }
    // The mouse knows too: covers Shift pressed in a text box, then moving to the list.
    const move = (e: MouseEvent) => setHeld(e.shiftKey)
    const reset = () => setHeld(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('mousemove', move)
    window.addEventListener('blur', reset)
    document.addEventListener('visibilitychange', reset)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('mousemove', move)
      window.removeEventListener('blur', reset)
      document.removeEventListener('visibilitychange', reset)
    }
  }, [])
  return held
}
