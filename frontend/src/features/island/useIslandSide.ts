import { useCallback, useSyncExternalStore } from 'react'
import { getSlots, subscribe } from '@/components/ui/topBarSlots'
import { useMediaQuery } from '@/hooks/useMediaQuery'

const PHONE = '(max-width: 767px)'

/** Whether the top bar's right part is on screen with nothing showing in it. */
function isFree(end: HTMLElement | null): boolean {
  // offsetParent is null while the bar itself is hidden (a page with its own phone header).
  if (!end || end.offsetParent === null) return false
  return !Array.from(end.children).some((child) => (child as HTMLElement).offsetWidth > 0)
}

/**
 * Where the Island sits in the top bar. In the middle, as a rule. On a phone, when the
 * page has no buttons at the right of the bar, it moves to that end instead, so the
 * page's title and the line under it have the room.
 */
export function useIslandSide(): 'center' | 'end' {
  const { end } = useSyncExternalStore(subscribe, getSlots)
  const phone = useMediaQuery(PHONE)
  // The page's buttons come and go with the page: look again whenever that part changes.
  const watch = useCallback((onChange: () => void) => {
    if (!end) return () => undefined
    const observer = new MutationObserver(onChange)
    observer.observe(end, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] })
    return () => observer.disconnect()
  }, [end])
  const free = useSyncExternalStore(watch, () => isFree(end))
  return phone && free ? 'end' : 'center'
}
