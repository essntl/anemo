import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from 'react'
import { motion, useDragControls } from 'motion/react'
import { EyeOff, GripVertical, Plus } from 'lucide-react'
import { cn } from '@/lib/cn'
import { spring } from '@/lib/motion'
import { MAX_SPAN, WIDGETS, type WidgetId, type WidgetLayout } from './layout'

// Written out in full so Tailwind finds them. Phones are always one column.
const COL_SPAN = ['', '', 'md:col-span-2', 'md:col-span-2 xl:col-span-3']
const ROW_SPAN = ['', '', 'md:row-span-2', 'md:row-span-3']

/** The grid's current number of columns and gap, read from its style (follows breakpoints). */
function gridMetrics(grid: HTMLElement) {
  const style = getComputedStyle(grid)
  const cols = style.gridTemplateColumns.split(' ').filter(Boolean).length || 1
  const gap = parseFloat(style.columnGap) || 16
  const colWidth = (grid.clientWidth - gap * (cols - 1)) / cols
  return { cols, gap, colWidth }
}

/** Pause after a swap while widgets slide into place, so neighbours don't ping-pong. */
const SETTLE_MS = 280

export interface GridActions {
  move: (id: WidgetId, toIndex: number) => void
  resize: (id: WidgetId, w: number, h: number) => void
  setHidden: (id: WidgetId, hidden: boolean) => void
}

function WidgetFrame({ item, index, prevIndex, nextIndex, editing, gridRef, actions, children }: {
  item: WidgetLayout
  index: number
  /** Positions of the neighbouring visible widgets (arrow keys skip hidden ones). */
  prevIndex: number
  nextIndex: number
  editing: boolean
  gridRef: RefObject<HTMLDivElement | null>
  actions: GridActions
  children: ReactNode
}) {
  const controls = useDragControls()
  const frameRef = useRef<HTMLDivElement>(null)
  const lastTarget = useRef<string | null>(null)
  const lastMove = useRef(0)
  const resize = useRef<{ x: number; y: number; w: number; h: number; cols: number; colStep: number; rowStep: number } | null>(null)
  const [lifted, setLifted] = useState(false)
  const [resizing, setResizing] = useState(false)
  const name = WIDGETS[item.id].name

  function startResize(e: PointerEvent<HTMLDivElement>) {
    const grid = gridRef.current
    const frame = frameRef.current
    if (!grid || !frame) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    const { cols, gap, colWidth } = gridMetrics(grid)
    const rect = frame.getBoundingClientRect()
    resize.current = { x: e.clientX, y: e.clientY, w: Math.min(item.w, cols), h: item.h, cols, colStep: colWidth + gap, rowStep: (rect.height + gap) / item.h }
    setResizing(true)
  }

  function onResizeMove(e: PointerEvent<HTMLDivElement>) {
    const r = resize.current
    if (!r) return
    const w = Math.max(1, Math.min(r.cols, r.w + Math.round((e.clientX - r.x) / r.colStep)))
    const h = Math.max(1, Math.min(MAX_SPAN, r.h + Math.round((e.clientY - r.y) / r.rowStep)))
    // On a narrower screen keep the saved (wider) width unless it was really changed.
    actions.resize(item.id, w === r.w ? item.w : w, h)
  }

  function endResize() {
    resize.current = null
    setResizing(false)
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!editing || e.target !== e.currentTarget) return
    const cols = gridRef.current ? gridMetrics(gridRef.current).cols : MAX_SPAN
    const w = Math.min(item.w, cols)
    const keys: Record<string, () => void> = e.shiftKey
      ? {
          ArrowRight: () => actions.resize(item.id, Math.min(cols, w + 1), item.h),
          ArrowLeft: () => actions.resize(item.id, w - 1, item.h),
          ArrowDown: () => actions.resize(item.id, item.w, item.h + 1),
          ArrowUp: () => actions.resize(item.id, item.w, item.h - 1),
        }
      : {
          ArrowRight: () => actions.move(item.id, nextIndex),
          ArrowDown: () => actions.move(item.id, nextIndex),
          ArrowLeft: () => actions.move(item.id, prevIndex),
          ArrowUp: () => actions.move(item.id, prevIndex),
          Delete: () => actions.setHidden(item.id, true),
          Backspace: () => actions.setHidden(item.id, true),
        }
    const run = keys[e.key]
    if (!run) return
    e.preventDefault()
    run()
    // Keep the focus on the widget after it moved.
    requestAnimationFrame(() => frameRef.current?.focus())
  }

  return (
    <motion.div
      ref={frameRef}
      data-widget={item.id}
      data-index={index}
      layout="position"
      transition={spring.smooth}
      drag={editing}
      dragControls={controls}
      dragListener={false}
      dragSnapToOrigin
      dragMomentum={false}
      whileDrag={{ scale: 1.02, boxShadow: 'var(--shadow-float)' }}
      onDragStart={() => {
        lastTarget.current = null
        setLifted(true)
      }}
      onDrag={(e, info) => {
        const pe = e as globalThis.PointerEvent
        const x = typeof pe.clientX === 'number' ? pe.clientX : info.point.x - window.scrollX
        const y = typeof pe.clientY === 'number' ? pe.clientY : info.point.y - window.scrollY
        // Scroll the page when dragging near its top or bottom edge.
        const scroller = frameRef.current?.closest('main')
        if (y < 90) scroller?.scrollBy(0, -14)
        else if (y > window.innerHeight - 72) scroller?.scrollBy(0, 14)
        const target = document
          .elementsFromPoint(x, y)
          .map((n) => (n as HTMLElement).closest<HTMLElement>('[data-widget]'))
          .find((n) => n && n.dataset.widget !== item.id)
        const id = target?.dataset.widget ?? null
        // Swap once per widget entered, after the grid has settled.
        if (performance.now() - lastMove.current < SETTLE_MS) return
        if (id && id !== lastTarget.current) {
          const to = Number(target!.dataset.index)
          if (!Number.isNaN(to)) {
            actions.move(item.id, to)
            lastMove.current = performance.now()
          }
        }
        lastTarget.current = id
      }}
      onDragEnd={() => setTimeout(() => setLifted(false), 450)}
      onPointerDown={(e) => {
        if (!editing || e.button !== 0) return
        const t = e.target as HTMLElement
        if (t.closest('[data-no-drag]')) return
        // Touch drags start from the grip only, so the page still scrolls.
        if (e.pointerType !== 'mouse' && !t.closest('[data-grip]')) return
        controls.start(e)
      }}
      onKeyDown={onKeyDown}
      tabIndex={editing ? 0 : undefined}
      role={editing ? 'group' : undefined}
      aria-label={editing ? `${name}, ${item.w} by ${item.h}. Arrow keys move it, Shift and arrows resize it.` : undefined}
      className={cn(
        'relative flex min-h-[9.5rem] min-w-0 flex-col rounded-card border border-border bg-card shadow-soft',
        COL_SPAN[item.w],
        ROW_SPAN[item.h],
        editing && 'cursor-grab select-none outline-2 outline-offset-2 outline-dashed active:cursor-grabbing focus-visible:outline-solid',
        editing && (lifted ? 'outline-transparent' : 'outline-border-strong focus-visible:outline-accent'),
        (lifted || resizing) && 'z-20',
      )}
    >
      <div inert={editing} className="flex min-h-0 flex-1 flex-col">
        {children}
      </div>

      {editing && (
        <>
          <div className="absolute right-2 top-2 z-10 flex items-center gap-0.5 rounded-control border border-border bg-card p-0.5 shadow-soft">
            <span data-grip title="Drag to move" aria-hidden
              className="flex h-7 w-7 cursor-grab touch-none items-center justify-center rounded-lg text-muted active:cursor-grabbing pointer-coarse:h-10 pointer-coarse:w-10">
              <GripVertical className="h-4 w-4" />
            </span>
            <button type="button" data-no-drag aria-label={`Hide ${name}`} title="Hide" onClick={() => actions.setHidden(item.id, true)}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-surface-hover hover:text-text pointer-coarse:h-10 pointer-coarse:w-10">
              <EyeOff className="h-4 w-4" />
            </button>
          </div>
          <span className="pointer-events-none absolute bottom-2 left-3 rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-semibold text-muted tabular-nums max-md:hidden">
            {item.w} × {item.h}
          </span>
          <div data-no-drag role="presentation" title="Drag to resize"
            onPointerDown={startResize} onPointerMove={onResizeMove} onPointerUp={endResize} onPointerCancel={endResize}
            className="absolute bottom-0 right-0 z-10 flex h-7 w-7 cursor-nwse-resize touch-none items-center justify-center max-md:hidden">
            <svg viewBox="0 0 10 10" className={cn('h-3 w-3', resizing ? 'text-accent' : 'text-muted')} aria-hidden>
              <path d="M9 1 1 9M9 5 5 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
            </svg>
          </div>
        </>
      )}
    </motion.div>
  )
}

/**
 * The Home grid: one column on a phone, two on `md`, three on `xl`. While `editing`,
 * widgets are dragged into place (mouse anywhere on them, touch by the grip),
 * resized from their corner, or moved and resized with the keyboard.
 */
export function WidgetGrid({ layout, editing, shown, actions, render }: {
  layout: WidgetLayout[]
  editing: boolean
  /** Widgets that have something to show (e.g. "Needs you" hides itself when empty). */
  shown: (item: WidgetLayout) => boolean
  actions: GridActions
  render: (item: WidgetLayout) => ReactNode
}) {
  const gridRef = useRef<HTMLDivElement>(null)
  const hidden = layout.filter((w) => w.hidden)
  const visible = layout.flatMap((w, i) => (!w.hidden && (editing || shown(w)) ? [i] : []))

  return (
    <>
      <div ref={gridRef} data-testid="widget-grid" className="grid grid-cols-1 gap-4 md:auto-rows-[minmax(9.5rem,auto)] md:grid-cols-2 xl:grid-cols-3">
        {visible.map((index, v) => {
          const item = layout[index]
          return (
            <WidgetFrame key={item.id} item={item} index={index} editing={editing} gridRef={gridRef} actions={actions}
              prevIndex={visible[Math.max(0, v - 1)]} nextIndex={visible[Math.min(visible.length - 1, v + 1)]}>
              {render(item)}
            </WidgetFrame>
          )
        })}
      </div>

      {editing && (
        <div className="mt-4 flex flex-wrap items-center gap-2 rounded-card border border-dashed border-border-strong px-4 py-3" aria-label="Add a widget" role="group">
          <span className="mr-1 text-[11.5px] font-semibold uppercase tracking-wider text-muted">Add a widget</span>
          {hidden.length === 0 ? (
            <span className="text-[13px] text-muted">Every widget is on the page. Hide one with its eye button.</span>
          ) : (
            hidden.map((w) => (
              <button key={w.id} type="button" onClick={() => actions.setHidden(w.id, false)}
                className="flex h-8 items-center gap-1 rounded-full bg-surface-2 px-3 text-[13px] font-medium hover:bg-surface-hover pointer-coarse:h-10">
                <Plus className="h-3.5 w-3.5" /> {WIDGETS[w.id].name}
              </button>
            ))
          )}
        </div>
      )}
    </>
  )
}
