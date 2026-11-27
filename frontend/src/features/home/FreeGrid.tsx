import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { EyeOff, GripVertical } from 'lucide-react'
import { matchesShortcut, SHORTCUTS } from '@/features/shortcuts/registry'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { closeHoles, GRID_COLS, moveTo, type Place, type Places, reflow, rowsUsed } from './gridPlaces'
import { WIDGETS, type WidgetId, type WidgetLayout } from './layout'
import { AddWidgets } from './WidgetGrid'

/** A row of the free grid at least; two rows and their gap are one slot of the usual grid
 *  (9.5rem). Like the slots, a row grows when a widget's content needs more. */
const ROW_REM = 4.25
const GAP_PX = 16
/** Below this width the grid shows half as many columns (places are scaled, gridPlaces.reflow). */
const NARROW_PX = 880

export interface FreeGridActions {
  /** `place` is on a grid of `cols` columns (what the window shows). */
  place: (id: WidgetId, place: Place, cols: number) => void
  setHidden: (id: WidgetId, hidden: boolean) => void
}

interface Gesture {
  id: WidgetId
  kind: 'move' | 'resize'
  x: number
  y: number
  /** Where the grid's top was when it started: the page may scroll while dragging. */
  top: number
  from: Place
  colStep: number
  /** Where each row starts and ends (px from the grid's top) when it started. */
  rows: { start: number; end: number }[]
}

/** The rows' tops and bottoms as laid out now, and a short row's size for those below. */
function rowTracks(grid: HTMLElement): { start: number; end: number }[] {
  const sizes = getComputedStyle(grid).gridTemplateRows.split(' ').map(parseFloat).filter((n) => !Number.isNaN(n))
  const out: { start: number; end: number }[] = []
  let at = 0
  for (const size of sizes) {
    out.push({ start: at, end: at + size })
    at += size + GAP_PX
  }
  return out
}

/** The row (index) whose top or bottom is nearest `px`, past the last one at a short row's pace. */
function nearestRow(rows: { start: number; end: number }[], px: number, edge: 'start' | 'end'): number {
  const short = ROW_REM * parseFloat(getComputedStyle(document.documentElement).fontSize || '16')
  const last = rows[rows.length - 1] ?? { start: -short - GAP_PX, end: -GAP_PX }
  const at = (i: number) => (i < rows.length ? rows[i][edge] : last[edge] + (i - rows.length + 1) * (short + GAP_PX))
  let best = 0
  for (let i = 1; i < rows.length + 50; i++) if (Math.abs(at(i) - px) < Math.abs(at(best) - px)) best = i
  return best
}

/**
 * Home on the free grid (full width): widgets sit where they were put, at their own
 * size, on 12 columns (6 on a narrower window). While `editing`, drag a widget to move it
 * (mouse anywhere on it, touch by its grip) and its corner to resize it; it snaps to the
 * cells, and the widgets in the way move down. With the keyboard: focus a widget, the
 * arrow keys move it by a cell, Shift and the arrows resize it.
 */
export function FreeGrid({ layout, places, editing, shown, available = () => true, actions, render }: {
  layout: WidgetLayout[]
  /** Every widget's place on 12 columns (gridPlaces.placesOf). */
  places: Places
  editing: boolean
  shown: (item: WidgetLayout) => boolean
  available?: (item: WidgetLayout) => boolean
  actions: FreeGridActions
  render: (item: WidgetLayout) => ReactNode
}) {
  const gridRef = useRef<HTMLDivElement>(null)
  const [cols, setCols] = useState(GRID_COLS)
  const [gesture, setGesture] = useState<Gesture | null>(null)
  const [preview, setPreview] = useState<Place | null>(null)

  useLayoutEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    const measure = () => setCols(grid.clientWidth < NARROW_PX ? GRID_COLS / 2 : GRID_COLS)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(grid)
    return () => observer.disconnect()
  }, [])

  const onPage = layout.filter((w) => !w.hidden && available(w))
  const visible = onPage.filter((w) => editing || shown(w))
  const ids = visible.map((w) => w.id)
  const gone = onPage.filter((w) => !visible.includes(w)).map((w) => w.id)
  const onScreen = reflow(places, onPage.map((w) => w.id), cols)
  let display = editing ? onScreen : closeHoles(onScreen, ids, gone)
  if (gesture && preview) display = moveTo(display, ids, gesture.id, preview, cols)
  const rows = rowsUsed(display.values()) + (editing ? 4 : 0)


  function start(e: PointerEvent<HTMLElement>, id: WidgetId, kind: Gesture['kind']) {
    const from = display.get(id)
    const grid = gridRef.current
    if (!from || !grid) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    setGesture({ id, kind, x: e.clientX, y: e.clientY, top: grid.getBoundingClientRect().top, from, colStep: (grid.clientWidth + GAP_PX) / cols, rows: rowTracks(grid) })
    setPreview(from)
  }

  function onMove(e: PointerEvent<HTMLElement>) {
    const g = gesture
    const grid = gridRef.current
    if (!g || !grid) return
    // Near the top or bottom of the window the page scrolls along.
    const scroller = grid.closest('main')
    if (e.clientY < 90) scroller?.scrollBy(0, -14)
    else if (e.clientY > window.innerHeight - 72) scroller?.scrollBy(0, 14)
    const dx = Math.round((e.clientX - g.x) / g.colStep)
    const dyPx = e.clientY - g.y + (g.top - grid.getBoundingClientRect().top)
    // Rows can be of different heights: go by where the widget's top (or bottom) would be.
    const next = g.kind === 'move'
      ? { ...g.from, x: Math.max(0, Math.min(cols - g.from.w, g.from.x + dx)), y: nearestRow(g.rows, (g.rows[g.from.y]?.start ?? 0) + dyPx, 'start') }
      : {
          ...g.from,
          w: Math.max(2, Math.min(cols - g.from.x, g.from.w + dx)),
          h: Math.max(2, Math.min(12, nearestRow(g.rows, (g.rows[g.from.y + g.from.h - 1]?.end ?? 0) + dyPx, 'end') - g.from.y + 1)),
        }
    if (!preview || next.x !== preview.x || next.y !== preview.y || next.w !== preview.w || next.h !== preview.h) setPreview(next)
  }

  function end() {
    if (gesture && preview) {
      const from = gesture.from
      if (preview.x !== from.x || preview.y !== from.y || preview.w !== from.w || preview.h !== from.h) actions.place(gesture.id, preview, cols)
    }
    setGesture(null)
    setPreview(null)
  }

  function onKeyDown(e: KeyboardEvent<HTMLElement>, item: WidgetLayout) {
    if (!editing || e.target !== e.currentTarget) return
    const p = display.get(item.id)
    if (!p) return
    const moves: Record<string, Place> = matchesShortcut(SHORTCUTS['home.resize'], e)
      ? {
          ArrowRight: { ...p, w: Math.min(cols - p.x, p.w + 1) },
          ArrowLeft: { ...p, w: p.w - 1 },
          ArrowDown: { ...p, h: p.h + 1 },
          ArrowUp: { ...p, h: p.h - 1 },
        }
      : matchesShortcut(SHORTCUTS['home.move'], e)
        ? {
            ArrowRight: { ...p, x: Math.min(cols - p.w, p.x + 1) },
            ArrowLeft: { ...p, x: Math.max(0, p.x - 1) },
            ArrowDown: { ...p, y: p.y + 1 },
            ArrowUp: { ...p, y: Math.max(0, p.y - 1) },
          }
        : {}
    if (matchesShortcut(SHORTCUTS['home.hide'], e)) {
      e.preventDefault()
      actions.setHidden(item.id, true)
      return
    }
    const next = moves[e.key]
    if (!next) return
    e.preventDefault()
    actions.place(item.id, next, cols)
    // Keep the focus on the widget after it moved.
    const frame = e.currentTarget
    requestAnimationFrame(() => frame.focus())
  }

  const gridStyle: CSSProperties = {
    gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${Math.max(rows, 1)}, minmax(${ROW_REM}rem, auto))`,
    gap: GAP_PX,
  }

  return (
    <>
      <div ref={gridRef} data-testid="widget-grid" data-grid="free" data-cols={cols} className="relative grid" style={gridStyle}>
        {editing && gesture && preview && (
          <div aria-hidden className="rounded-card border-2 border-dashed border-accent bg-accent-soft"
            style={{ gridColumn: `${preview.x + 1} / span ${preview.w}`, gridRow: `${preview.y + 1} / span ${preview.h}` }} />
        )}
        {visible.map((item) => {
          const p = display.get(item.id)
          if (!p) return null
          const name = t(WIDGETS[item.id].name)
          const active = gesture?.id === item.id
          return (
            <div key={item.id} data-widget={item.id} data-place={`${p.x},${p.y},${p.w},${p.h}`}
              style={{ gridColumn: `${p.x + 1} / span ${p.w}`, gridRow: `${p.y + 1} / span ${p.h}` }}
              tabIndex={editing ? 0 : undefined}
              role={editing ? 'group' : undefined}
              aria-label={editing ? t('{name}, {w} by {h}, at column {x}, row {y}. Arrow keys move it, Shift and arrows resize it.', { name, w: p.w, h: p.h, x: p.x + 1, y: p.y + 1 }) : undefined}
              onKeyDown={(e) => onKeyDown(e, item)}
              onPointerDown={(e) => {
                if (!editing || e.button !== 0) return
                const target = e.target as HTMLElement
                if (target.closest('[data-no-drag]')) return
                // Touch drags start from the grip only, so the page still scrolls.
                if (e.pointerType !== 'mouse' && !target.closest('[data-grip]')) return
                start(e, item.id, 'move')
              }}
              onPointerMove={onMove} onPointerUp={end} onPointerCancel={end}
              className={cn(
                'relative flex min-w-0 flex-col rounded-card border border-border bg-card shadow-soft transition-[box-shadow,opacity]',
                editing && 'cursor-grab select-none outline-2 outline-offset-2 outline-dashed active:cursor-grabbing focus-visible:outline-solid',
                editing && (active ? 'z-20 opacity-90 shadow-float outline-transparent' : 'outline-border-strong focus-visible:outline-accent'),
              )}>
              <div inert={editing} className="flex min-h-0 flex-1 flex-col">
                {render(item)}
              </div>

              {editing && (
                <>
                  <div className="absolute right-2 top-2 z-10 flex items-center gap-0.5 rounded-control border border-border bg-card p-0.5 shadow-soft">
                    <span data-grip title={t('Drag to move')} aria-hidden
                      className="flex h-7 w-7 cursor-grab touch-none items-center justify-center rounded-lg text-muted active:cursor-grabbing pointer-coarse:h-10 pointer-coarse:w-10">
                      <GripVertical className="h-4 w-4" />
                    </span>
                    <button type="button" data-no-drag aria-label={t('Hide {name}', { name })} title={t('Hide')} onClick={() => actions.setHidden(item.id, true)}
                      className="flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-surface-hover hover:text-text pointer-coarse:h-10 pointer-coarse:w-10">
                      <EyeOff className="h-4 w-4" />
                    </button>
                  </div>
                  <span className="pointer-events-none absolute bottom-2 left-3 rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-semibold text-muted tabular-nums">
                    {p.w} × {p.h}
                  </span>
                  <div data-no-drag data-resize role="presentation" title={t('Drag to resize')}
                    onPointerDown={(e) => e.button === 0 && start(e, item.id, 'resize')}
                    className="absolute bottom-0 right-0 z-10 flex h-7 w-7 cursor-nwse-resize touch-none items-center justify-center">
                    <svg viewBox="0 0 10 10" className={cn('h-3 w-3', active && gesture?.kind === 'resize' ? 'text-accent' : 'text-muted')} aria-hidden>
                      <path d="M9 1 1 9M9 5 5 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
                    </svg>
                  </div>
                </>
              )}
            </div>
          )
        })}
      </div>

      {editing && <AddWidgets hidden={layout.filter((w) => w.hidden && available(w))} onShow={(id) => actions.setHidden(id, false)} />}
    </>
  )
}
