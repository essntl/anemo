import { type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

/** From this many messages on, only the ones in sight are in the page. A shorter chat is
 *  drawn whole: nothing changes for it, and the browser's find-in-page sees every message. */
export const VIRTUAL_FROM = 60

/**
 * A long chat's messages, windowed: the ones in sight (and a few around them) are in the
 * page, the others are space of their measured (or, until seen, estimated) height. A
 * message that grows (a streaming answer, another version, a diagram that finished
 * drawing) is measured again; `onResize` is called when the total height changes, so the
 * chat can stay at the bottom (useStickToBottom keeps whether it should).
 *
 * In a long chat the browser's find-in-page only finds the messages in the page; the
 * chat's own search (the command palette) searches all of them.
 */
export function VirtualMessages<T extends { id: string }>({ items, scroller, render, onResize }: {
  items: T[]
  scroller: RefObject<HTMLDivElement | null>
  render: (item: T) => ReactNode
  onResize: () => void
}) {
  const list = useRef<HTMLDivElement>(null)
  // Where the list starts in the scrolling area (under its padding and the "branched from"
  // link). Read once mounted: the scrolling area is the page's, and its ref is only set
  // after this list's own layout effects, so the list is drawn again once it is.
  const [margin, setMargin] = useState<number | null>(null)
  useEffect(() => {
    setMargin(list.current?.offsetTop ?? 0)
  }, [])
  const getItemKey = useCallback((i: number) => items[i].id, [items])
  const virtual = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 180,
    getItemKey,
    overscan: 6,
    scrollMargin: margin ?? 0,
  })
  const total = virtual.getTotalSize()
  useLayoutEffect(onResize, [total, onResize])

  return (
    <div ref={list} data-testid="virtual-messages" className="relative w-full" style={{ height: total }}>
      {virtual.getVirtualItems().map((row) => (
        <div key={row.key} ref={virtual.measureElement} data-index={row.index}
          // The gap between messages is part of each one, so it is measured with it.
          className="absolute left-0 top-0 w-full pb-(--msg-gap)"
          style={{ transform: `translateY(${row.start - (margin ?? 0)}px)` }}>
          {render(items[row.index])}
        </div>
      ))}
    </div>
  )
}
