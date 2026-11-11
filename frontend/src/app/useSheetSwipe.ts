import { useEffect } from 'react'
import { closeTopOverlay } from './overlays'

/** A pull on a bottom sheet: how far down, in how long, and how tall the sheet is. */
export interface Pull {
  dy: number
  ms: number
  height: number
}

/** Whether letting go there puts the sheet away: a quick flick down, or a pull of a good part of it. */
export function dismisses({ dy, ms, height }: Pull): boolean {
  if (dy <= 0) return false
  const flick = dy > 48 && dy / Math.max(ms, 1) > 0.5
  return flick || dy > Math.min(160, height * 0.3)
}

/**
 * Whether a touch that starts on `target` may pull `sheet` down: not while something
 * between them is scrolled down (the finger scrolls that back up first), and not from
 * a control that uses up-and-down movement itself.
 */
export function canPull(target: EventTarget | null, sheet: HTMLElement): boolean {
  for (let el = target instanceof HTMLElement ? target : null; el; el = el.parentElement) {
    if (el instanceof HTMLTextAreaElement || el.isContentEditable || el.dataset.noSwipe !== undefined) return false
    if (el instanceof HTMLInputElement && el.type === 'range') return false
    if (el.scrollTop > 0) return false
    if (el === sheet) return true
  }
  return false
}

/** Lets the sheet slide back up to where it sits. */
function settle(sheet: HTMLElement) {
  sheet.style.transition = 'transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1)'
  sheet.style.transform = ''
  window.setTimeout(() => {
    sheet.style.transition = ''
  }, 220)
}

/**
 * On phones, every bottom sheet (the `.sheet` class: dialogs, action menus, the More
 * sheet) follows a finger that pulls it down, and goes away when let go far enough or
 * with a flick; otherwise it slides back. Does nothing from `md` up, where the same
 * dialogs sit in the middle of the screen.
 */
export function useSheetSwipe() {
  useEffect(() => {
    const phone = window.matchMedia('(max-width: 767px)')
    let pull: { sheet: HTMLElement; x: number; y: number; at: number; moving: boolean; dy: number } | null = null

    const onStart = (e: TouchEvent) => {
      pull = null
      if (!phone.matches || e.touches.length !== 1) return
      const sheet = e.target instanceof Element ? e.target.closest<HTMLElement>('.sheet[data-state="open"]') : null
      if (!sheet || !canPull(e.target, sheet)) return
      const touch = e.touches[0]
      pull = { sheet, x: touch.clientX, y: touch.clientY, at: e.timeStamp, moving: false, dy: 0 }
    }
    const onMove = (e: TouchEvent) => {
      if (!pull) return
      const touch = e.touches[0]
      const dx = touch.clientX - pull.x
      const dy = touch.clientY - pull.y
      if (!pull.moving) {
        // Upwards or sideways first: the finger is scrolling or swiping something else.
        if (dy < -6 || Math.abs(dx) > Math.max(10, Math.abs(dy))) {
          pull = null
          return
        }
        if (dy < 8) return
        pull.moving = true
        pull.sheet.style.transition = 'none'
      }
      // The sheet moves with the finger; the page behind must not scroll or reload.
      if (e.cancelable) e.preventDefault()
      pull.dy = Math.max(0, dy)
      pull.sheet.style.transform = `translateY(${pull.dy}px)`
    }
    const onEnd = (e: TouchEvent) => {
      const done = pull
      pull = null
      if (!done?.moving) return
      const { sheet } = done
      if (!dismisses({ dy: done.dy, ms: e.timeStamp - done.at, height: sheet.offsetHeight })) return settle(sheet)
      // It leaves from where the finger let go: its closing animation starts at this offset.
      closeTopOverlay()
      // One that has to be answered stays open: it goes back up.
      window.setTimeout(() => {
        if (sheet.isConnected && sheet.dataset.state === 'open') settle(sheet)
      }, 250)
    }

    document.addEventListener('touchstart', onStart, { passive: true })
    document.addEventListener('touchmove', onMove, { passive: false })
    document.addEventListener('touchend', onEnd)
    document.addEventListener('touchcancel', onEnd)
    return () => {
      document.removeEventListener('touchstart', onStart)
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend', onEnd)
      document.removeEventListener('touchcancel', onEnd)
    }
  }, [])
}
