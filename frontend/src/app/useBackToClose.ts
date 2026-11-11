import { useEffect } from 'react'
import { closeTopOverlay, openOverlays } from './overlays'

/** The browser's CloseWatcher (Chromium): told when the user asks to close something, e.g. Android's back. */
interface Watcher {
  onclose: (() => void) | null
  destroy: () => void
}
type WatcherClass = new () => Watcher

/** Marks the history entry this module adds while something is open (browsers without CloseWatcher). */
const MARK = 'anemoOverlay'
const marked = () => Boolean((history.state as Record<string, unknown> | null)?.[MARK])

/**
 * Makes "back" close what is open over the page (a sheet, a menu, a dialog, the drawer)
 * instead of leaving the page: one back per layer, the topmost first. Returns how to stop.
 *
 * Where the browser has CloseWatcher, it holds one while something is open; the browser
 * then hands it the back gesture. Elsewhere it adds a history entry while something is
 * open, so "back" has something to go back to, and closes the top layer when it does.
 * An entry left behind (the layer was closed another way) is stepped over.
 */
export function watchBack(): () => void {
  const Native = (window as unknown as { CloseWatcher?: WatcherClass }).CloseWatcher
  let watcher: Watcher | null = null
  // Without CloseWatcher: our entry is the current one and stands for an open layer.
  let holding = false
  // Without CloseWatcher: our entry is the current one, but its layer was closed another way.
  let stale = false
  let escapeAt = -Infinity
  let queued = false

  const sync = () => {
    queued = false
    const open = openOverlays() > 0
    if (Native) {
      if (open && !watcher) {
        const mine = new Native()
        watcher = mine
        mine.onclose = () => {
          if (watcher === mine) watcher = null
          // The Esc key also ends up here, after it has closed the top layer itself.
          if (performance.now() - escapeAt > 150) closeTopOverlay()
          queue() // what is still open gets the next back
        }
      } else if (!open && watcher) {
        const mine = watcher
        watcher = null
        mine.destroy()
      }
      return
    }
    // A page change since then put another entry on top of the one we left behind.
    if (stale && !marked()) stale = false
    if (open && !holding) {
      // A left-behind entry of ours is reused; otherwise one is added, as a copy of the
      // current one so the router sees the same page.
      if (!stale) history.pushState({ ...(history.state as object | null), [MARK]: true }, '')
      holding = true
      stale = false
    } else if (!open && holding) {
      holding = false
      // Still on our entry: it stays, and the next back steps over it. (After a link was
      // followed the current entry is the new page's, and ours is behind it.)
      stale = marked()
    }
  }
  const queue = () => {
    if (queued) return
    queued = true
    queueMicrotask(sync)
  }

  const onPop = () => {
    if (Native) return
    if (holding) {
      // Back while a layer is open: we are off our entry now, and the layer goes.
      holding = false
      if (openOverlays() > 0) closeTopOverlay()
      queue()
    } else if (marked()) {
      // Came back onto an entry of ours whose layer is long gone: step over it.
      stale = false
      history.back()
    } else if (stale) {
      // Left our left-behind entry: this back was meant for the page itself.
      stale = false
      history.back()
    }
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.isTrusted && e.key === 'Escape') escapeAt = performance.now()
  }

  const observer = new MutationObserver(queue)
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state', 'data-overlay'] })
  window.addEventListener('popstate', onPop)
  document.addEventListener('keydown', onKey, true)
  queue()
  return () => {
    observer.disconnect()
    window.removeEventListener('popstate', onPop)
    document.removeEventListener('keydown', onKey, true)
    watcher?.destroy()
  }
}

/**
 * On touch devices (where there is a back gesture or button and no Esc key), back closes
 * what is open over the page before it leaves the page. See watchBack.
 */
export function useBackToClose() {
  useEffect(() => {
    if (!window.matchMedia('(pointer: coarse)').matches) return
    return watchBack()
  }, [])
}
