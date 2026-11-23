import { useCallback, useEffect, useRef, useState } from 'react'

/** Closer to the end than this still counts as being at the end. */
const NEAR = 80
/** Farther from the end than this, the way back is offered. */
const FAR = 400

/**
 * Keeps a scrolling thread at its end while it grows, until the user scrolls up.
 *
 * It follows the size of the content, not a count of events: a thread settles in steps
 * (each job's events load, Markdown lays out, the box under it grows), and each step
 * moves the end. `away` says the end is far below (for a "jump to the end" button);
 * `toEnd` goes there and follows again (after sending a message).
 */
export function useFollowEnd() {
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const [away, setAway] = useState(false)

  const toEnd = useCallback((smooth = false) => {
    const el = scroller.current
    if (!el) return
    following.current = true
    setAway(false)
    if (smooth && typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    else el.scrollTop = el.scrollHeight
  }, [])

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const gap = () => el.scrollHeight - el.scrollTop - el.clientHeight
    // A smooth jump passes through "far from the end" on its way: it keeps following.
    let last = el.scrollTop
    const onScroll = () => {
      const up = el.scrollTop < last
      last = el.scrollTop
      if (up) following.current = gap() < NEAR
      else if (gap() < NEAR) following.current = true
      setAway(!following.current && gap() > FAR)
    }
    const onResize = () => {
      if (following.current) el.scrollTop = el.scrollHeight
      else setAway(gap() > FAR)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onResize)
    observer?.observe(el)
    if (content.current) observer?.observe(content.current)
    onResize()
    return () => {
      el.removeEventListener('scroll', onScroll)
      observer?.disconnect()
    }
  }, [])

  return { scroller, content, away, toEnd }
}
