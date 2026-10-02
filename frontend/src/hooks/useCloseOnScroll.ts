import { useEffect } from 'react'

/**
 * Closes a popover as soon as anything on the page scrolls. A popover stays attached
 * to its button, so scrolling a list would otherwise drag it along and out of the list.
 */
export function useCloseOnScroll(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return
    // Scroll events do not bubble; listening in the capture phase catches every scroller.
    window.addEventListener('scroll', close, { capture: true, passive: true })
    return () => window.removeEventListener('scroll', close, { capture: true })
  }, [open, close])
}
