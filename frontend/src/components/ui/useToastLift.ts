import { type RefObject, useEffect } from 'react'

/** Within this many pixels of the window's bottom edge an element counts as docked there. */
const DOCKED = 160

/**
 * How far notices must rise to clear `rect`: from the window's bottom to its top edge,
 * when it is shown and docked at the bottom (a message box, a phone's tab bar). Nothing
 * for an element that is hidden (`display: none`) or sits higher up (the message box in
 * the middle of a new chat).
 */
export function liftFor(rect: Pick<DOMRect, 'top' | 'bottom' | 'height'>, windowHeight: number): number {
  if (rect.height === 0 || rect.bottom < windowHeight - DOCKED) return 0
  return Math.max(0, Math.round(windowHeight - rect.top))
}

/** The lift each mounted element asks for; the notices clear the highest. */
const lifts = new Map<HTMLElement, number>()

function apply() {
  const root = document.documentElement
  if (lifts.size === 0) root.style.removeProperty('--toast-lift')
  else root.style.setProperty('--toast-lift', `${Math.max(...lifts.values())}px`)
}

/**
 * Keeps the toasts above something docked at the bottom of a page (a message box, the
 * phone's tab bar): while `ref` is on screen there, they sit over its top edge and not on
 * it. Several can be mounted at once (the tab bar is only hidden on wide screens): the
 * highest lift wins. ToastHost reads the distance from `--toast-lift`.
 */
export function useToastLift(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const place = () => {
      lifts.set(el, liftFor(el.getBoundingClientRect(), window.innerHeight))
      apply()
    }
    place()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
    observer?.observe(el)
    window.addEventListener('resize', place)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', place)
      lifts.delete(el)
      apply()
    }
  }, [ref])
}
