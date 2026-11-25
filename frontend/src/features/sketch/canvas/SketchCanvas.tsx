/**
 * STUB (replaced by the canvas implementation): the drawing surface with its toolbar.
 *
 * Contract: the canvas starts from `data` and calls `onChange` with the whole new drawing
 * after every committed change (a stroke ends, an undo, a move…), never mid-stroke. A new
 * `data` from outside (a reload) is shown by remounting it with another `key`.
 */
import type { SketchData } from '../model'

export interface SketchCanvasProps {
  data: SketchData
  onChange: (next: SketchData) => void
  /** Revisions and embeds: no toolbar, no drawing; pan and zoom still work. */
  readOnly?: boolean
  className?: string
}

export function SketchCanvas({ className }: SketchCanvasProps) {
  return <div className={className} />
}
