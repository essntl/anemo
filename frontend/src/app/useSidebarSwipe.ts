import { useEffect } from 'react'
import { useMobileNav } from './mobileNavStore'

/** A finger movement, from where it went down to where it lifted. */
export interface Swipe {
  dx: number
  dy: number
  ms: number
}

const MIN_DISTANCE = 64 // px sideways before it counts
const MAX_DURATION = 600 // ms: slower than this is a drag or a scroll, not a swipe

/** Which way a movement swiped, if it was a quick and clearly sideways one. */
export function swipeDirection({ dx, dy, ms }: Swipe): 'left' | 'right' | null {
  if (ms > MAX_DURATION || Math.abs(dx) < MIN_DISTANCE) return null
  if (Math.abs(dx) < Math.abs(dy) * 2) return null // mostly vertical: the page is scrolling
  return dx > 0 ? 'right' : 'left'
}

/**
 * Whether a touch that starts on `target` belongs to something that uses sideways
 * movement itself: a field you select text in, a slider, anything that scrolls
 * sideways (code blocks, tables, the task board), or an area marked `data-no-swipe`.
 */
export function ownsHorizontalTouch(target: EventTarget | null): boolean {
  for (let el = target instanceof Element ? target : null; el; el = el.parentElement) {
    if (el instanceof HTMLElement) {
      const editable = el.isContentEditable || (el.hasAttribute('contenteditable') && el.getAttribute('contenteditable') !== 'false')
      if (editable || el.dataset.noSwipe !== undefined) return true
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true
      if (el.scrollWidth > el.clientWidth + 1) {
        const overflow = getComputedStyle(el).overflowX
        if (overflow === 'auto' || overflow === 'scroll') return true
      }
    }
  }
  return false
}

/**
 * On phones: swipe right anywhere on a page to open the menu, swipe left to close it.
 * Does nothing from the `md` breakpoint up, where the sidebar is always visible.
 */
export function useSidebarSwipe() {
  useEffect(() => {
    const phone = window.matchMedia('(max-width: 767px)')
    let start: { x: number; y: number; at: number; open: boolean } | null = null

    const onStart = (e: TouchEvent) => {
      start = null
      if (!phone.matches || e.touches.length !== 1) return
      const open = useMobileNav.getState().open
      // With the menu closed, leave sideways gestures to whatever is under the finger.
      // With it open, everything on screen is the menu or the dimmed page behind it.
      if (!open && (document.querySelector('[role="dialog"]') || ownsHorizontalTouch(e.target))) return
      const touch = e.touches[0]
      start = { x: touch.clientX, y: touch.clientY, at: e.timeStamp, open }
    }

    const onEnd = (e: TouchEvent) => {
      if (!start) return
      const touch = e.changedTouches[0]
      const direction = swipeDirection({ dx: touch.clientX - start.x, dy: touch.clientY - start.y, ms: e.timeStamp - start.at })
      if (direction === 'right' && !start.open) useMobileNav.getState().setOpen(true)
      if (direction === 'left' && start.open) useMobileNav.getState().setOpen(false)
      start = null
    }

    const onCancel = () => { start = null }
    document.addEventListener('touchstart', onStart, { passive: true })
    document.addEventListener('touchend', onEnd, { passive: true })
    document.addEventListener('touchcancel', onCancel, { passive: true })
    return () => {
      document.removeEventListener('touchstart', onStart)
      document.removeEventListener('touchend', onEnd)
      document.removeEventListener('touchcancel', onCancel)
    }
  }, [])
}
