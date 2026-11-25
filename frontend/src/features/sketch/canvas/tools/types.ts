/**
 * What a drawing tool is: something that starts a session when a pointer goes down, gets
 * the points the pointer moves through, and finishes (or is cancelled) when it lifts. The
 * canvas gives each session a ToolHost to read the drawing and make changes through.
 */
import type { SketchData, SketchItem, TextBox } from '../../model'
import type { EraseMode } from '../eraser'
import type { SketchTheme } from '../palette'
import type { Ctx } from '../render'

export type ToolId = 'pen' | 'highlighter' | 'eraser' | 'select' | 'line' | 'arrow' | 'rect' | 'ellipse' | 'text' | 'hand'

/** A pointer position in sheet units. */
export interface ToolPoint {
  x: number
  y: number
  /** 0–1 (inkPressure). */
  pressure: number
  /** Shift held: square shapes, lines at 45° steps. */
  shift: boolean
}

export interface ToolHost {
  /** The drawing as it was when the session started (or after its last commit). */
  readonly data: SketchData
  readonly zoom: number
  /** The colour and size chosen for the current tool. */
  readonly color: string
  readonly width: number
  readonly eraseMode: EraseMode
  readonly selection: ReadonlySet<string>
  /**
   * Makes `items` the drawing's items: one step of undo, saved. Refused (false, with a
   * message) when that would break a limit of the server.
   */
  commit(items: SketchItem[]): boolean
  /** Shows these items instead of the drawing's until the next commit (null: the drawing's again). */
  preview(items: readonly SketchItem[] | null): void
  select(ids: Iterable<string>): void
  /** Leaves these items out of the drawing layer (the session draws them itself). */
  hide(ids: ReadonlySet<string> | null): void
  /** Opens the text field: on an existing text box, or a new one at (x, y). */
  editText(target: TextBox | { x: number; y: number }): void
}

export interface ToolSession {
  /** The points the pointer moved through since the last call (coalesced events). */
  move(points: ToolPoint[]): void
  end(point: ToolPoint): void
  cancel(): void
  /** Draws the session on the top layer (the context is in sheet units). */
  draw?(ctx: Ctx, theme: SketchTheme, zoom: number): void
}

export type BeginTool = (host: ToolHost, point: ToolPoint) => ToolSession | null
