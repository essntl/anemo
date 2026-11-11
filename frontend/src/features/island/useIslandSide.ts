import { useCallback, useSyncExternalStore } from 'react'
import { getSlots, subscribe } from '@/components/ui/topBarSlots'
import { useMediaQuery } from '@/hooks/useMediaQuery'

const PHONE = '(max-width: 767px)'
/** The space kept free on each side of the Island, between it and the title or a button. */
const GAP = 8

/**
 * Where the Island is in the top bar:
 *  - `center`: in the middle, at its full size (wider screens, and pages without the bar),
 *  - `end`: a phone page with no buttons at the right of the bar: it sits at that end,
 *  - `between`: a phone page with a title at the left and buttons at the right: in the
 *    middle, with `room` pixels to fit into, so neither side ends up under it.
 */
export type IslandPlace = 'center' | 'end' | 'between'

/** What the right part of the top bar holds: nothing on screen, something, or the bar is not showing. */
function rightPart(end: HTMLElement | null): 'none' | 'free' | 'used' {
  // offsetParent is null while the bar itself is hidden (a page with its own phone header).
  if (!end || end.offsetParent === null) return 'none'
  return Array.from(end.children).some((child) => (child as HTMLElement).offsetWidth > 0) ? 'used' : 'free'
}

/**
 * How much of this element's own content is cut off sideways (a truncated title). Only
 * where the element clips: what merely reaches past its box (a larger tap area) is not cut.
 */
const cut = (el: Element) =>
  // A label kept for screen readers only (a clipped 1px box) is not text waiting for room either.
  el.clientWidth <= 1 || getComputedStyle(el).overflowX === 'visible' ? 0 : Math.max(0, el.scrollWidth - el.clientWidth)
/** That, for the element and everything in it. */
const cutWithin = (el: Element) => cut(el) + Array.from(el.querySelectorAll('*')).reduce((sum, inner) => sum + cut(inner), 0)

/**
 * The width between the page's title and its buttons that the Island may take, centred
 * in the bar. Both sides are measured as they would be with nothing cut off, so the
 * answer does not depend on how wide the Island is at the moment.
 */
export function roomBetween(start: HTMLElement | null, end: HTMLElement | null): number {
  const bar = end?.parentElement
  const lines = start?.parentElement
  if (!bar || !lines || !end) return Infinity
  const box = bar.getBoundingClientRect()
  const centre = box.left + box.width / 2
  // The left side: the title's line and the line under it, whichever reaches further.
  let titleEnds = box.left
  for (const line of Array.from(lines.children)) {
    const drawn = Array.from(line.querySelectorAll('*')).reduce((right, el) => Math.max(right, el.getBoundingClientRect().right), 0)
    if (drawn > 0) titleEnds = Math.max(titleEnds, drawn + cutWithin(line))
  }
  // The right side: the buttons at their full widths, counted back from the bar's edge.
  const style = getComputedStyle(end)
  const shown = Array.from(end.children).filter((child) => (child as HTMLElement).offsetWidth > 0) as HTMLElement[]
  const widths = shown.reduce((sum, child) => {
    const margins = getComputedStyle(child)
    return sum + child.offsetWidth + cutWithin(child) + (parseFloat(margins.marginLeft) || 0) + (parseFloat(margins.marginRight) || 0)
  }, 0)
  const gaps = Math.max(0, shown.length - 1) * (parseFloat(style.columnGap) || 0)
  const buttonsStart = end.getBoundingClientRect().right - (parseFloat(style.paddingRight) || 0) - widths - gaps
  return Math.max(0, Math.floor(2 * Math.min(centre - titleEnds, buttonsStart - centre) - 2 * GAP))
}

/**
 * Where the Island sits on this page (see IslandPlace), and for `between`, how many
 * pixels wide it may be (`room`; unlimited otherwise).
 */
export function useIslandPlace(): { place: IslandPlace; room: number } {
  const { start, end } = useSyncExternalStore(subscribe, getSlots)
  const phone = useMediaQuery(PHONE)
  // The title and the buttons come and go with the page: look again whenever the bar changes.
  const watch = useCallback((onChange: () => void) => {
    const bar = end?.parentElement
    if (!bar) return () => undefined
    const observer = new MutationObserver(onChange)
    observer.observe(bar, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden'] })
    window.addEventListener('resize', onChange)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', onChange)
    }
  }, [end])
  const right = useSyncExternalStore(watch, () => rightPart(end))
  const between = phone && right === 'used'
  const room = useSyncExternalStore(watch, () => (between ? roomBetween(start, end) : Infinity))
  if (!phone || right === 'none') return { place: 'center', room: Infinity }
  return { place: right === 'free' ? 'end' : 'between', room }
}
