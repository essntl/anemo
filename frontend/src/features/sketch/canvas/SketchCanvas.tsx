/**
 * The drawing surface of a sketch document, with its toolbar and zoom controls.
 *
 * Contract: the canvas starts from `data` and calls `onChange` with the whole new drawing
 * after every committed change (a stroke ends, an undo, a move…), never mid-stroke. A new
 * `data` from outside (a reload) is shown by remounting it with another `key`.
 *
 * Two canvases: the drawing layer (saved items, drawn again only when they or the view
 * change) and the top layer (what is being drawn now). See painter.ts.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { toast } from '@/components/ui/toast'
import { matchesShortcut, SHORTCUTS, type ShortcutId } from '@/features/shortcuts/registry'
import { isTyping } from '@/hooks/useShortcut'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { isText, LIMITS, newItemId, roundCoord, type SketchData, type SketchItem, type TextBox } from '../model'
import type { Point } from './geometry'
import { canRedo, canUndo, record, redo, startHistory, undo, type History } from './history'
import { fingerDraws, wheelViewport } from './input'
import { selectionBounds, selectionFrame } from './lasso'
import { checkChange, checkPages, limitMessage } from './limits'
import { drawEraserCursor, drawSelectionBox } from './overlay'
import { Painter } from './painter'
import { SketchToolbar, type SheetSettings } from './SketchToolbar'
import { SketchZoom } from './SketchZoom'
import { TextEditor, type TextDraft } from './TextEditor'
import { eraserRadius } from './tools/erase'
import { TOOLS, type ToolHost, type ToolId } from './tools'
import { DEFAULT_STYLE, styleFor, type ToolStyle } from './toolStyle'
import { usePointerInput } from './usePointerInput'
import { useSketchTheme } from './useSketchTheme'
import { clampViewport, fitViewport, initialViewport, ZOOM_STEP, zoomAt, type Viewport } from './viewport'

export interface SketchCanvasProps {
  data: SketchData
  onChange: (next: SketchData) => void
  /** Revisions and embeds: no toolbar, no drawing; pan and zoom still work. */
  readOnly?: boolean
  className?: string
  /** The zoom buttons in the corner (default: shown). */
  showZoomControls?: boolean
}

const EMPTY: ReadonlySet<string> = new Set()

/** Remembered in this browser: a pen was used here, so fingers move the view from the start. */
const PEN_SEEN_KEY = 'anemo.sketch.penSeen'

function storedPenSeen(): boolean {
  try {
    return localStorage.getItem(PEN_SEEN_KEY) === '1'
  } catch {
    return false
  }
}

const TOOL_KEYS: [ShortcutId, ToolId][] = [
  ['sketch.pen', 'pen'], ['sketch.highlighter', 'highlighter'], ['sketch.eraser', 'eraser'], ['sketch.select', 'select'],
  ['sketch.text', 'text'], ['sketch.line', 'line'], ['sketch.arrow', 'arrow'], ['sketch.rect', 'rect'], ['sketch.ellipse', 'ellipse'],
]

export function SketchCanvas({ data, onChange, readOnly = false, className, showZoomControls = true }: SketchCanvasProps) {
  const theme = useSketchTheme()
  const [history, setHistory] = useState(() => startHistory(data))
  const [view, setViewState] = useState<Viewport | null>(null)
  const [tool, setToolState] = useState<ToolId>('pen')
  const [style, setStyle] = useState<ToolStyle>(DEFAULT_STYLE)
  const [selection, setSelectionState] = useState<ReadonlySet<string>>(EMPTY)
  const [draft, setDraftState] = useState<TextDraft | null>(null)
  const [fingerSetting, setFingerSetting] = useState<boolean | null>(null)
  const [penSeen, setPenSeen] = useState(storedPenSeen)
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [dragging, setDragging] = useState(false)

  const container = useRef<HTMLDivElement>(null)
  const baseCanvas = useRef<HTMLCanvasElement>(null)
  const topCanvas = useRef<HTMLCanvasElement>(null)
  const painter = useRef<Painter | null>(null)
  const toolbarBox = useRef<HTMLDivElement>(null)
  const size = useRef({ width: 0, height: 0 })
  // What event handlers read: always the latest, without waiting for a render.
  const historyRef = useRef(history)
  const viewRef = useRef<Viewport | null>(null)
  const selectionRef = useRef(selection)
  const draftRef = useRef<TextDraft | null>(null)
  const previewRef = useRef<readonly SketchItem[] | null>(null)
  const hiddenRef = useRef<ReadonlySet<string> | null>(null)
  const hoverRef = useRef<Point | null>(null)
  const themeRef = useRef(theme)
  const onChangeRef = useRef(onChange)
  const latest = useRef({ tool, style, readOnly, penSeen, fingerSetting, spaceHeld })
  useLayoutEffect(() => {
    onChangeRef.current = onChange
    latest.current = { tool, style, readOnly, penSeen, fingerSetting, spaceHeld }
  })

  /** Hands the painter what to draw now. */
  const syncScene = useCallback(() => {
    const p = painter.current, v = viewRef.current
    if (!p || !v) return
    const present = historyRef.current.present
    p.setScene({ data: present, items: previewRef.current ?? present.items, view: v, theme: themeRef.current, hidden: hiddenRef.current })
  }, [])

  const redrawOverlay = useCallback(() => painter.current?.redrawOverlay(), [])

  /** The screen pixels the floating toolbar covers at the top (one row, or two on a phone): a new view starts below it. */
  const toolbarRoom = useCallback(() => {
    const box = toolbarBox.current
    return box ? box.offsetTop + box.offsetHeight : 0
  }, [])

  const setView = useCallback((next: Viewport) => {
    const v = clampViewport(next, size.current.width, size.current.height)
    viewRef.current = v
    setViewState(v)
    syncScene()
  }, [syncScene])

  const setSelection = useCallback((ids: ReadonlySet<string>) => {
    selectionRef.current = ids
    setSelectionState(ids)
    redrawOverlay()
  }, [redrawOverlay])

  const setPreview = useCallback((items: readonly SketchItem[] | null) => {
    previewRef.current = items
    syncScene()
  }, [syncScene])

  const setHidden = useCallback((ids: ReadonlySet<string> | null) => {
    hiddenRef.current = ids
    syncScene()
  }, [syncScene])

  const applyHistory = useCallback((h: History) => {
    historyRef.current = h
    previewRef.current = null
    setHistory(h)
    syncScene()
  }, [syncScene])

  /** A finished change: one step of undo, and the parent saves it. */
  const commitData = useCallback((next: SketchData) => {
    applyHistory(record(historyRef.current, next))
    onChangeRef.current(next)
  }, [applyHistory])

  const commitItems = useCallback((items: SketchItem[]): boolean => {
    const problem = checkChange(historyRef.current.present.items, items)
    if (problem) {
      toast({ message: limitMessage(problem) })
      setPreview(null)
      return false
    }
    commitData({ ...historyRef.current.present, items })
    return true
  }, [commitData, setPreview])

  const stepHistory = useCallback((step: typeof undo) => {
    const h = step(historyRef.current)
    if (h === historyRef.current) return
    // What is still there stays selected (an undone move keeps its selection).
    if (selectionRef.current.size > 0) {
      const present = new Set(h.present.items.map((item) => item.id))
      setSelection(new Set([...selectionRef.current].filter((id) => present.has(id))))
    }
    applyHistory(h)
    onChangeRef.current(h.present)
  }, [applyHistory, setSelection])

  const deleteSelection = useCallback(() => {
    const ids = selectionRef.current
    if (ids.size === 0) return
    setSelection(EMPTY)
    commitItems(historyRef.current.present.items.filter((item) => !ids.has(item.id)))
  }, [commitItems, setSelection])

  const changeSheet = useCallback((change: Partial<SheetSettings>) => {
    const next = { ...historyRef.current.present, ...change }
    const problem = checkPages(next.pages)
    if (problem) {
      toast({ message: limitMessage(problem) })
      return
    }
    commitData(next)
    if (change.layout) setView(initialViewport(next, size.current.width, size.current.height, toolbarRoom()))
  }, [commitData, setView, toolbarRoom])

  // --- Text boxes -----------------------------------------------------------------------

  const setDraft = useCallback((next: TextDraft | null) => {
    draftRef.current = next
    setDraftState(next)
  }, [])

  const openText = useCallback((target: TextBox | { x: number; y: number }) => {
    if ('id' in target) {
      const { id, ...rest } = target
      setDraft({ ...rest, id })
      setHidden(new Set([id]))
    } else {
      const { colors, sizes } = latest.current.style
      setDraft({ type: 'text', id: null, x: roundCoord(target.x), y: roundCoord(target.y), size: sizes.text, color: colors.ink, text: '' })
    }
  }, [setDraft, setHidden])

  /** Saves the text box being typed (an emptied one is removed) and closes the field. */
  const commitText = useCallback(() => {
    const d = draftRef.current
    if (!d) return
    setDraft(null)
    setHidden(null)
    const items = historyRef.current.present.items
    const text = d.text.slice(0, LIMITS.textChars)
    const empty = text.trim() === ''
    const { id, ...fields } = d
    if (id) {
      const old = items.find((item) => item.id === id)
      if (!old || !isText(old)) return
      if (empty) commitItems(items.filter((item) => item.id !== id))
      else if (old.text !== text) commitItems(items.map((item) => (item.id === id ? { ...old, text } : item)))
    } else if (!empty) {
      const box: TextBox = { ...fields, id: newItemId(), text }
      if (box.width == null) delete box.width
      commitItems([...items, box])
    }
  }, [commitItems, setDraft, setHidden])

  // --- Tools ----------------------------------------------------------------------------

  const setTool = useCallback((next: ToolId) => {
    setToolState(next)
    if (next !== 'select') setSelection(EMPTY)
    hoverRef.current = null
    redrawOverlay()
  }, [redrawOverlay, setSelection])

  const makeHost = useCallback((): ToolHost => {
    const { tool: current, style: s } = latest.current
    const { color, width } = styleFor(s, current)
    return {
      get data() {
        return historyRef.current.present
      },
      zoom: viewRef.current?.zoom ?? 1,
      color,
      width,
      eraseMode: s.eraseMode,
      selection: selectionRef.current,
      commit: commitItems,
      preview: setPreview,
      select: (ids) => setSelection(new Set(ids)),
      hide: setHidden,
      editText: openText,
    }
  }, [commitItems, openText, setHidden, setPreview, setSelection])

  const input = usePointerInput({
    element: () => container.current,
    getView: () => viewRef.current,
    setView,
    policy: () => {
      const l = latest.current
      return { readOnly: l.readOnly, panning: l.tool === 'hand' || l.spaceHeld, penSeen: l.penSeen, fingerSetting: l.fingerSetting }
    },
    begin: (point) => {
      // A tap on the canvas leaves the text field: its text is kept. With the text tool
      // that tap only does this (it doesn't start another text box straight away).
      const wasTyping = draftRef.current !== null
      commitText()
      container.current?.focus({ preventScroll: true })
      const current = latest.current.tool
      if (current === 'hand' || (wasTyping && current === 'text')) return null
      return TOOLS[current](makeHost(), point)
    },
    onPen: () => {
      if (latest.current.penSeen) return
      latest.current.penSeen = true
      setPenSeen(true)
      try {
        localStorage.setItem(PEN_SEEN_KEY, '1')
      } catch {
        // Private mode: remembered until the page closes.
      }
    },
    onOverlay: redrawOverlay,
    onHover: (p) => {
      if (latest.current.tool !== 'eraser' && !hoverRef.current) return
      hoverRef.current = p
      redrawOverlay()
    },
    onDragging: setDragging,
  })
  const inputRef = useRef(input)
  useLayoutEffect(() => {
    inputRef.current = input
  })

  // --- The layers -----------------------------------------------------------------------

  useLayoutEffect(() => {
    const base = baseCanvas.current, top = topCanvas.current, box = container.current
    if (!base || !top || !box) return
    const p = new Painter(base, top)
    painter.current = p
    p.setOverlay((ctx, zoom) => {
      const th = themeRef.current
      const session = inputRef.current.session()
      if (session?.draw) {
        session.draw(ctx, th, zoom)
        return
      }
      const box2 = selectionBounds(historyRef.current.present.items, selectionRef.current)
      if (box2) drawSelectionBox(ctx, selectionFrame(box2, zoom), th, zoom)
      const hover = hoverRef.current
      if (hover && latest.current.tool === 'eraser') {
        drawEraserCursor(ctx, hover.x, hover.y, eraserRadius(latest.current.style.sizes.eraser, zoom), th, zoom)
      }
    })

    const measure = () => {
      const width = box.clientWidth, height = box.clientHeight
      size.current = { width, height }
      p.resize(width, height, window.devicePixelRatio || 1)
      if (!viewRef.current && width > 0 && height > 0) setView(initialViewport(historyRef.current.present, width, height, toolbarRoom()))
      else syncScene()
    }
    measure()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    observer?.observe(box)

    // Not React's onWheel: that one is passive, and the page must not scroll instead.
    const onWheel = (e: WheelEvent) => {
      const v = viewRef.current
      if (!v || e.target !== top) return
      e.preventDefault()
      const rect = box.getBoundingClientRect()
      setView(wheelViewport(v, e, e.clientX - rect.left, e.clientY - rect.top, size.current.height))
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      observer?.disconnect()
      box.removeEventListener('wheel', onWheel)
      inputRef.current.cancel()
      p.destroy()
      painter.current = null
    }
  }, [setView, syncScene, toolbarRoom])

  // The eraser's circle follows its size.
  useEffect(() => redrawOverlay(), [style, redrawOverlay])

  useEffect(() => {
    themeRef.current = theme
    syncScene()
    redrawOverlay()
  }, [theme, syncScene, redrawOverlay])

  // --- Keys -----------------------------------------------------------------------------

  const zoomBy = useCallback((factor: number) => {
    const v = viewRef.current
    if (v) setView(zoomAt(v, factor, size.current.width / 2, size.current.height / 2))
  }, [setView])
  const fit = useCallback(() => setView(fitViewport(historyRef.current.present, size.current.width, size.current.height, toolbarRoom())), [setView, toolbarRoom])
  const resetZoom = useCallback(() => {
    const v = viewRef.current
    if (v) zoomBy(1 / v.zoom)
  }, [zoomBy])

  function onKeyDown(e: KeyboardEvent) {
    if (isTyping(e.target)) return
    // Single keys only while the canvas itself has the focus: a focused button keeps Space
    // and Enter, a menu of the toolbar its arrows.
    if (e.target !== e.currentTarget && !(e.ctrlKey || e.metaKey)) return
    const k = e.nativeEvent
    const is = (id: ShortcutId) => matchesShortcut(SHORTCUTS[id], k)
    let handled = true
    if (is('sketch.zoomIn')) zoomBy(ZOOM_STEP)
    else if (is('sketch.zoomOut')) zoomBy(1 / ZOOM_STEP)
    else if (is('sketch.fit')) fit()
    else if (is('sketch.pan')) setSpaceHeld(true)
    else if (readOnly) handled = false
    else if (is('sketch.undo')) stepHistory(undo)
    else if (is('sketch.redo')) stepHistory(redo)
    else if (is('sketch.delete') && selectionRef.current.size > 0) deleteSelection()
    else if (is('sketch.deselect') && selectionRef.current.size > 0) setSelection(EMPTY)
    else {
      const hit = TOOL_KEYS.find(([id]) => is(id))
      if (hit) setTool(hit[1])
      else handled = false
    }
    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  const effectiveFinger = fingerDraws(penSeen, fingerSetting)
  const cursor = readOnly || tool === 'hand' || spaceHeld
    ? (dragging ? 'cursor-grabbing' : 'cursor-grab')
    : tool === 'text' ? 'cursor-text' : tool === 'select' ? 'cursor-default' : 'cursor-crosshair'

  return (
    <div ref={container} tabIndex={0} role="group" aria-roledescription={t('drawing canvas')} aria-label={t('Sketch')}
      className={cn('relative isolate overflow-hidden bg-surface outline-none select-none touch-none', className)}
      onKeyDown={onKeyDown}
      onKeyUp={(e) => e.key === ' ' && setSpaceHeld(false)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setSpaceHeld(false)
      }}>
      <canvas ref={baseCanvas} aria-hidden className="absolute inset-0 h-full w-full" />
      <canvas ref={topCanvas} aria-hidden data-testid="sketch-input"
        className={cn('absolute inset-0 h-full w-full touch-none', cursor)}
        onPointerDown={(e) => {
          // For the keys (a tap with the hand tool doesn't start a tool, which focuses too).
          if (!draftRef.current) container.current?.focus({ preventScroll: true })
          input.onPointerDown(e)
        }}
        onPointerMove={input.onPointerMove} onPointerUp={input.onPointerUp}
        onPointerCancel={input.onPointerCancel} onPointerLeave={input.onPointerLeave}
        onContextMenu={(e) => e.preventDefault()} />
      {draft && view && (
        <TextEditor draft={draft} view={view} theme={theme} onText={(text) => setDraft({ ...draft, text })} onDone={commitText} />
      )}
      {!readOnly && (
        <div ref={toolbarBox} className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center px-2">
          <SketchToolbar className="pointer-events-auto"
            tool={tool} onTool={setTool} style={style} onStyle={setStyle}
            canUndo={canUndo(history)} canRedo={canRedo(history)}
            onUndo={() => stepHistory(undo)} onRedo={() => stepHistory(redo)}
            hasSelection={selection.size > 0} onDeleteSelection={deleteSelection}
            sheet={history.present} onSheet={changeSheet}
            fingerDraws={effectiveFinger} onFingerDraws={setFingerSetting} />
        </div>
      )}
      {showZoomControls && view && (
        <SketchZoom className="absolute bottom-3 right-3 z-20" zoom={view.zoom}
          onZoomIn={() => zoomBy(ZOOM_STEP)} onZoomOut={() => zoomBy(1 / ZOOM_STEP)} onReset={resetZoom} onFit={fit} />
      )}
    </div>
  )
}
