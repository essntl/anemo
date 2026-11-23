import { type RefObject, useEffect } from 'react'

/**
 * Keeps the toasts above something docked at the bottom of a page (a message box):
 * while `ref` is on screen, they sit over its top edge and not on it. ToastHost reads
 * the distance from `--toast-lift`.
 */
export function useToastLift(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const root = document.documentElement
    const place = () => root.style.setProperty('--toast-lift', `${Math.max(0, Math.round(window.innerHeight - el.getBoundingClientRect().top))}px`)
    place()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
    observer?.observe(el)
    window.addEventListener('resize', place)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', place)
      root.style.removeProperty('--toast-lift')
    }
  }, [ref])
}
