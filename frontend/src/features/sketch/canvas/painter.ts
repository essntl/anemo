/**
 * The two canvas layers. The drawing layer holds the saved items and is drawn again only
 * when they, the view, the size or the theme change; the top layer (the stroke being
 * drawn, a shape, the lasso, the selection) is cheap and drawn every frame something on
 * it moves. Both wait for the next animation frame, so many changes cost one draw.
 */
import type { SketchData, SketchItem } from '../model'
import type { SketchTheme } from './palette'
import { applyView, drawScene, type Ctx } from './render'
import type { Viewport } from './viewport'

export interface PainterScene {
  data: Pick<SketchData, 'layout' | 'background' | 'pages'>
  items: readonly SketchItem[]
  view: Viewport
  theme: SketchTheme
  hidden: ReadonlySet<string> | null
}

/** Draws the top layer; the context is already in sheet units. */
export type OverlayDraw = (ctx: Ctx, zoom: number) => void

type Schedule = (run: () => void) => number
type Unschedule = (id: number) => void

export class Painter {
  private base: HTMLCanvasElement
  private top: HTMLCanvasElement
  private baseCtx: CanvasRenderingContext2D | null
  private topCtx: CanvasRenderingContext2D | null
  private scene: PainterScene | null = null
  private overlay: OverlayDraw | null = null
  private width = 0
  private height = 0
  private dpr = 1
  private baseDirty = false
  private topDirty = false
  private frame: number | null = null
  private schedule: Schedule
  private unschedule: Unschedule
  /** How many items the last drawing-layer draw showed (for tests and curiosity). */
  lastDrawn = 0

  constructor(base: HTMLCanvasElement, top: HTMLCanvasElement, schedule?: Schedule, unschedule?: Unschedule) {
    this.base = base
    this.top = top
    this.baseCtx = base.getContext('2d')
    this.topCtx = top.getContext('2d')
    this.schedule = schedule ?? ((run) => requestAnimationFrame(run))
    this.unschedule = unschedule ?? ((id) => cancelAnimationFrame(id))
  }

  resize(width: number, height: number, dpr: number): void {
    if (width === this.width && height === this.height && dpr === this.dpr) return
    this.width = width
    this.height = height
    this.dpr = dpr
    for (const canvas of [this.base, this.top]) {
      canvas.width = Math.max(1, Math.round(width * dpr))
      canvas.height = Math.max(1, Math.round(height * dpr))
    }
    this.invalidate(true, true)
  }

  setScene(scene: PainterScene): void {
    const old = this.scene
    this.scene = scene
    const same = old && old.data === scene.data && old.items === scene.items && old.view === scene.view && old.theme === scene.theme && old.hidden === scene.hidden
    // The top layer is in sheet units too: a new view moves it.
    if (!same) this.invalidate(true, !old || old.view !== scene.view)
  }

  setOverlay(draw: OverlayDraw | null): void {
    this.overlay = draw
    this.invalidate(false, true)
  }

  /** Asks for the top layer to be drawn again (something on it moved). */
  redrawOverlay(): void {
    this.invalidate(false, true)
  }

  private invalidate(base: boolean, top: boolean): void {
    this.baseDirty ||= base
    this.topDirty ||= top
    if (this.frame === null) this.frame = this.schedule(() => this.flush())
  }

  /** Draws what is waiting now (the next frame does it otherwise). */
  flush(): void {
    if (this.frame !== null) this.unschedule(this.frame)
    this.frame = null
    const scene = this.scene
    if (!scene || this.width === 0 || this.height === 0) return
    if (this.baseDirty && this.baseCtx) {
      this.lastDrawn = drawScene(this.baseCtx, {
        data: scene.data, items: scene.items, view: scene.view, theme: scene.theme,
        width: this.width, height: this.height, dpr: this.dpr, hidden: scene.hidden ?? undefined,
      })
    }
    if (this.topDirty && this.topCtx) {
      const ctx = this.topCtx
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, this.width * this.dpr, this.height * this.dpr)
      if (this.overlay) {
        applyView(ctx, scene.view, this.dpr)
        this.overlay(ctx, scene.view.zoom)
      }
    }
    this.baseDirty = false
    this.topDirty = false
  }

  destroy(): void {
    if (this.frame !== null) this.unschedule(this.frame)
    this.frame = null
  }
}
