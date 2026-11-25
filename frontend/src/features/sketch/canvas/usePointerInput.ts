/**
 * Pointer handling of the canvas: a pointer either draws (it runs a tool session) or
 * moves the view (one pointer pans, two pinch). Which one is pointerRole's decision
 * (palm rejection); a second finger that lands while a finger draws turns the stroke
 * into a pinch. Drawing reads the coalesced events, so fast pen strokes stay smooth.
 */
import { useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import type { Point } from './geometry'
import { inkPressure, pinchViewport, pointerRole, type PinchStart } from './input'
import type { ToolPoint, ToolSession } from './tools/types'
import { panBy, toSheet, type Viewport } from './viewport'

export interface InputPolicy {
  readOnly: boolean
  /** The hand tool, or Space held. */
  panning: boolean
  penSeen: boolean
  fingerSetting: boolean | null
}

export interface PointerInputOptions {
  element: () => HTMLElement | null
  getView: () => Viewport | null
  setView: (view: Viewport) => void
  policy: () => InputPolicy
  /** Starts the current tool at a point; null when the tool has nothing to do. */
  begin: (point: ToolPoint) => ToolSession | null
  /** A pen touched the screen (from now on, fingers move the view). */
  onPen: () => void
  /** Something the top layer shows has changed. */
  onOverlay: () => void
  /** Where a pointer hovers (sheet units), or null when it left. */
  onHover: (point: Point | null) => void
  /** Whether the view is being dragged (for the cursor). */
  onDragging: (on: boolean) => void
}

interface Drawing {
  pointerId: number
  pointerType: string
  session: ToolSession
  pressure: number | null
  /** The pointer on screen, in case a second finger turns this into a pinch. */
  screen: Point
}

type Gesture = { kind: 'pan'; view: Viewport; from: Point } | { kind: 'pinch'; start: PinchStart; ids: [number, number] }

export function usePointerInput(options: PointerInputOptions) {
  const opts = useRef(options)
  useLayoutEffect(() => {
    opts.current = options
  })
  const drawing = useRef<Drawing | null>(null)
  const pointers = useRef(new Map<number, Point>())
  const gesture = useRef<Gesture | null>(null)
  const origin = useRef({ left: 0, top: 0 })

  const screenOf = (e: { clientX: number; clientY: number }): Point => ({ x: e.clientX - origin.current.left, y: e.clientY - origin.current.top })

  const toolPoint = (e: PointerEvent, previous: number | null): ToolPoint => {
    const view = opts.current.getView()!
    const s = screenOf(e)
    const p = toSheet(view, s.x, s.y)
    return { x: p.x, y: p.y, pressure: inkPressure(e, previous), shift: e.shiftKey }
  }

  /** Starts panning or pinching again from where the pointers are now (one was added or lifted). */
  const anchor = () => {
    const view = opts.current.getView()
    const entries = [...pointers.current.entries()]
    if (!view || entries.length === 0) {
      gesture.current = null
      opts.current.onDragging(false)
      return
    }
    opts.current.onDragging(true)
    if (entries.length === 1) {
      gesture.current = { kind: 'pan', view, from: entries[0][1] }
    } else {
      const [[ia, a], [ib, b]] = entries
      gesture.current = { kind: 'pinch', start: { view, a, b }, ids: [ia, ib] }
    }
  }

  const stopDrawing = (cancel: boolean, e?: PointerEvent) => {
    const d = drawing.current
    if (!d) return
    drawing.current = null
    if (cancel || !e) d.session.cancel()
    else d.session.end(toolPoint(e, d.pressure))
    opts.current.onOverlay()
  }

  function onPointerDown(e: ReactPointerEvent<HTMLElement>) {
    const o = opts.current
    if (!o.getView()) return
    const native = e.nativeEvent
    if (e.pointerType === 'pen') o.onPen()
    const policy = o.policy()
    const role = pointerRole({ pointerType: e.pointerType, button: e.button, ...policy, penSeen: policy.penSeen || e.pointerType === 'pen' })
    if (role === 'ignore') return
    e.preventDefault()
    const rect = o.element()?.getBoundingClientRect()
    origin.current = { left: rect?.left ?? 0, top: rect?.top ?? 0 }
    e.currentTarget.setPointerCapture?.(e.pointerId)

    const d = drawing.current
    if (d) {
      // A second finger while a finger draws: the two of them pinch instead. Anything
      // else while drawing (a palm next to the pen) is ignored.
      if (d.pointerType !== 'touch' || e.pointerType !== 'touch') return
      stopDrawing(true)
      pointers.current.set(d.pointerId, d.screen)
    } else if (role === 'draw') {
      if (pointers.current.size > 0) {
        // The view is being moved: only a pen (after a palm landed first) takes over.
        if (e.pointerType !== 'pen') return
        pointers.current.clear()
        anchor()
      }
      const first = toolPoint(native, null)
      const session = o.begin(first)
      if (session) drawing.current = { pointerId: e.pointerId, pointerType: e.pointerType, session, pressure: first.pressure, screen: screenOf(e) }
      o.onOverlay()
      return
    }
    pointers.current.set(e.pointerId, screenOf(e))
    anchor()
  }

  function onPointerMove(e: ReactPointerEvent<HTMLElement>) {
    const o = opts.current
    const d = drawing.current
    if (d && d.pointerId === e.pointerId) {
      const native = e.nativeEvent
      const events = native.getCoalescedEvents?.() ?? []
      const points: ToolPoint[] = []
      for (const ev of events.length ? events : [native]) {
        const p = toolPoint(ev, d.pressure)
        d.pressure = p.pressure
        points.push(p)
      }
      d.screen = screenOf(native)
      d.session.move(points)
      o.onOverlay()
      return
    }
    if (pointers.current.has(e.pointerId)) {
      pointers.current.set(e.pointerId, screenOf(e))
      const g = gesture.current
      if (!g) return
      if (g.kind === 'pan') {
        const now = pointers.current.get(e.pointerId)!
        o.setView(panBy(g.view, now.x - g.from.x, now.y - g.from.y))
      } else {
        const a = pointers.current.get(g.ids[0]), b = pointers.current.get(g.ids[1])
        if (a && b) o.setView(pinchViewport(g.start, a, b))
      }
      return
    }
    // Hovering (a mouse, or a pen above the screen): the eraser shows where it would erase.
    const view = o.getView()
    if (!view || e.pointerType === 'touch') return
    const rect = o.element()?.getBoundingClientRect()
    o.onHover(toSheet(view, e.clientX - (rect?.left ?? 0), e.clientY - (rect?.top ?? 0)))
  }

  function finish(e: ReactPointerEvent<HTMLElement>, cancel: boolean) {
    if (drawing.current?.pointerId === e.pointerId) {
      stopDrawing(cancel, e.nativeEvent)
      return
    }
    if (pointers.current.delete(e.pointerId)) anchor()
  }

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => finish(e, false),
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => finish(e, true),
    onPointerLeave: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.pointerType !== 'touch' && !drawing.current) opts.current.onHover(null)
    },
    /** The session running now, for the top layer to draw. */
    session: (): ToolSession | null => drawing.current?.session ?? null,
    /** Stops whatever is going on (the component unmounts, a key cancels). */
    cancel: () => {
      stopDrawing(true)
      pointers.current.clear()
      anchor()
    },
  }
}
