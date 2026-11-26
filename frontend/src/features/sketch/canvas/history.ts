/**
 * Undo and redo: whole drawings, kept by reference. Items are never changed in place,
 * so two versions share every item they have in common and a step costs little memory.
 */
import type { SketchData } from '../model'

export interface History {
  past: SketchData[]
  present: SketchData
  future: SketchData[]
}

/** How many steps back undo can go. */
export const HISTORY_LIMIT = 200

export const startHistory = (present: SketchData): History => ({ past: [], present, future: [] })

/** A new change: it becomes the present, and what was undone can no longer be redone. */
export function record(h: History, next: SketchData, limit = HISTORY_LIMIT): History {
  if (next === h.present) return h
  const past = [...h.past, h.present]
  if (past.length > limit) past.splice(0, past.length - limit)
  return { past, present: next, future: [] }
}

export const canUndo = (h: History): boolean => h.past.length > 0
export const canRedo = (h: History): boolean => h.future.length > 0

export function undo(h: History): History {
  if (!canUndo(h)) return h
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] }
}

export function redo(h: History): History {
  if (!canRedo(h)) return h
  return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) }
}
