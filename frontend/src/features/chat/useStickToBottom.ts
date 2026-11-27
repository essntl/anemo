import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'

/** Keeps the view pinned to the bottom while new text streams in, unless the user scrolled
 * up. It follows when `dep` changes, and when `follow` is called (by a streaming message
 * that re-renders on its own, without the page). */
export function useStickToBottom(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [])
  const follow = useCallback(() => {
    const el = ref.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [])
  useLayoutEffect(follow, [dep, follow])
  return { ref, follow }
}
