/**
 * Dragging a board card with a pointer. A mouse drags once it has moved a few pixels;
 * a finger (or pen) has to rest on the card for a moment first (a long press), so a
 * swipe still scrolls the page and the board. While a card is dragged the board scrolls
 * itself near its edges, and the page near the window's top and bottom.
 *
 * The hook only follows the pointer; what is under it, and what a drop means, is the
 * board's business (the callbacks).
 */
import { type MouseEvent, type PointerEvent, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'

/** A finger resting this long on a card picks it up. */
export const LONG_PRESS_MS = 400
/** A mouse that moves this far with the button down starts a drag. */
const MOUSE_SLOP = 5
/** A finger that moves this far before the long press is over is scrolling instead. */
const TOUCH_SLOP = 8
/** How close to an edge the pointer has to be for the board or page to scroll. */
const EDGE = 48
const SCROLL_STEP = 14

/** What is being dragged: the card's id, its column and where the pointer held it. */
export interface DragStart {
  id: string
  column: string
  /** The card's box when it was picked up. */
  rect: DOMRect
  /** The pointer's position inside the card. */
  offsetX: number
  offsetY: number
}

interface Callbacks {
  onLift: (start: DragStart) => void
  onMove: (x: number, y: number) => void
  onDrop: () => void
  onCancel: () => void
}

type Gesture = {
  phase: 'pending' | 'dragging'
  pointerId: number
  touch: boolean
  startX: number
  startY: number
  x: number
  y: number
  start: DragStart
  timer: ReturnType<typeof setTimeout> | null
  scroll: ReturnType<typeof setInterval> | null
  cleanup: () => void
}

/** Controls a pointer is pressed on keep their own behaviour (a select, a button). */
const OWN_CONTROLS = 'button, select, input, textarea, [role="combobox"], [data-no-drag]'

export function usePointerDrag(scroller: RefObject<HTMLElement | null>, callbacks: Callbacks) {
  const gesture = useRef<Gesture | null>(null)
  const latest = useRef(callbacks)
  // The click that follows a drop must not open the card.
  const swallowClick = useRef(false)
  const [dragging, setDragging] = useState(false)
  useLayoutEffect(() => {
    latest.current = callbacks
  })

  // A dragging finger must not scroll the page. Registered once, not passive, so the
  // browser asks before it scrolls; it only says no while a card is being dragged.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const block = (e: TouchEvent) => {
      if (gesture.current?.phase === 'dragging') e.preventDefault()
    }
    el.addEventListener('touchmove', block, { passive: false })
    return () => el.removeEventListener('touchmove', block)
  }, [scroller])

  // Leaving the page mid-drag: nothing stays behind.
  useEffect(() => () => gesture.current?.cleanup(), [])

  function autoScroll() {
    const g = gesture.current
    const board = scroller.current
    if (!g || !board) return
    const box = board.getBoundingClientRect()
    if (g.x < box.left + EDGE) board.scrollBy({ left: -SCROLL_STEP })
    else if (g.x > box.right - EDGE) board.scrollBy({ left: SCROLL_STEP })
    const page = board.closest('main') ?? document.scrollingElement
    if (g.y < EDGE + 40) page?.scrollBy({ top: -SCROLL_STEP })
    else if (g.y > window.innerHeight - EDGE) page?.scrollBy({ top: SCROLL_STEP })
  }

  function lift(g: Gesture) {
    g.phase = 'dragging'
    if (g.timer) clearTimeout(g.timer)
    g.timer = null
    g.scroll = setInterval(() => {
      autoScroll()
      if (gesture.current) latest.current.onMove(gesture.current.x, gesture.current.y)
    }, 50)
    if (g.touch) navigator.vibrate?.(8)
    setDragging(true)
    latest.current.onLift(g.start)
    latest.current.onMove(g.x, g.y)
  }

  function end(drop: boolean) {
    const g = gesture.current
    if (!g) return
    g.cleanup()
    gesture.current = null
    if (g.phase !== 'dragging') return
    swallowClick.current = true
    setTimeout(() => { swallowClick.current = false }, 0)
    setDragging(false)
    if (drop) latest.current.onDrop()
    else latest.current.onCancel()
  }

  function onPointerDown(e: PointerEvent<HTMLElement>, id: string, column: string) {
    if (gesture.current || (e.pointerType === 'mouse' && e.button !== 0)) return
    if ((e.target as HTMLElement).closest(OWN_CONTROLS)) return
    const rect = e.currentTarget.getBoundingClientRect()
    const touch = e.pointerType !== 'mouse'
    const move = (ev: globalThis.PointerEvent) => {
      const g = gesture.current
      if (!g || ev.pointerId !== g.pointerId) return
      g.x = ev.clientX
      g.y = ev.clientY
      const far = Math.hypot(g.x - g.startX, g.y - g.startY)
      if (g.phase === 'dragging') latest.current.onMove(g.x, g.y)
      else if (!g.touch && far > MOUSE_SLOP) lift(g)
      else if (g.touch && far > TOUCH_SLOP) end(false) // a swipe: let it scroll
    }
    const up = (ev: globalThis.PointerEvent) => {
      if (ev.pointerId === gesture.current?.pointerId) end(true)
    }
    const cancel = (ev: globalThis.PointerEvent) => {
      if (ev.pointerId === gesture.current?.pointerId) end(false)
    }
    const g: Gesture = {
      phase: 'pending', pointerId: e.pointerId, touch, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY,
      start: { id, column, rect, offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top },
      timer: null,
      scroll: null,
      cleanup: () => {
        if (g.timer) clearTimeout(g.timer)
        if (g.scroll) clearInterval(g.scroll)
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', cancel)
      },
    }
    if (touch) g.timer = setTimeout(() => gesture.current === g && lift(g), LONG_PRESS_MS)
    gesture.current = g
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
  }

  /** On the card, in the capture phase: the click a drop ends with doesn't open it (or follow its link). */
  function onClickCapture(e: MouseEvent) {
    if (!swallowClick.current) return
    e.preventDefault()
    e.stopPropagation()
  }

  /** A long press shows no context menu while it picks the card up. */
  function onContextMenu(e: MouseEvent) {
    if (gesture.current?.touch) e.preventDefault()
  }

  /** Stop dragging and put the card back (Esc). */
  const cancel = () => end(false)

  return { onPointerDown, onClickCapture, onContextMenu, cancel, dragging }
}
