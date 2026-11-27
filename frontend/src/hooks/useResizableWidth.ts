import { useCallback, useState } from 'react'

export interface ResizableWidth {
  width: number
  min: number
  max: number
  /** Sets the width (kept between `min` and `max`); `save: false` while dragging. */
  setWidth: (width: number, save?: boolean) => void
  reset: () => void
}

/**
 * A panel width the user can drag (with `ResizeHandle`), remembered on this device under
 * `storageKey` (an `anemo.` key). Kept between `min` and `max`.
 */
export function useResizableWidth(storageKey: string, { initial, min, max }: { initial: number; min: number; max: number }): ResizableWidth {
  const clamp = useCallback((w: number) => Math.round(Math.min(max, Math.max(min, w))), [min, max])
  const [width, setState] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(storageKey))
      return stored ? clamp(stored) : initial
    } catch {
      return initial
    }
  })
  const setWidth = useCallback((next: number, save = true) => {
    const w = clamp(next)
    setState(w)
    if (save) {
      try { localStorage.setItem(storageKey, String(w)) } catch { /* no storage: just not remembered */ }
    }
  }, [clamp, storageKey])
  const reset = useCallback(() => {
    setState(initial)
    try { localStorage.removeItem(storageKey) } catch { /* nothing to forget */ }
  }, [initial, storageKey])
  return { width, min, max, setWidth, reset }
}
