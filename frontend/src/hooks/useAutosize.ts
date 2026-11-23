import { type RefObject, useLayoutEffect } from 'react'

/**
 * A textarea as tall as its text, up to `max` pixels; only past that it scrolls. Its
 * smallest height is its `rows`. Pair it with `resize-none`: the size follows the text,
 * not a drag handle.
 */
export function useAutosize(ref: RefObject<HTMLTextAreaElement | null>, value: string, max = 240): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    // The borders count: scrollHeight leaves them out, and a box a pixel short scrolls.
    const full = el.scrollHeight + (el.offsetHeight - el.clientHeight)
    el.style.height = `${Math.min(full, max)}px`
    el.style.overflowY = full > max ? 'auto' : 'hidden'
  }, [ref, value, max])
}
