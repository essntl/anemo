/**
 * A drawing not yet saved, kept on this device (no connection, the tab closed before the
 * save): restored when the sketch is opened again, removed once the server has it.
 */
import type { SketchData } from './model'

/** Browser storage: one key a sketch. */
export const draftKey = (id: string) => `anemo.sketchDraft.${id}`

export interface SketchDraft {
  data: SketchData
  /** The title typed, when it changed. */
  title: string | null
  /** The file version the drawing was made on. */
  baseHash: string
  /** When it was drawn (ms since 1970). */
  at: number
}

export function readDraft(id: string): SketchDraft | null {
  try {
    const value = JSON.parse(localStorage.getItem(draftKey(id)) ?? 'null') as Partial<SketchDraft> | null
    if (!value || typeof value.baseHash !== 'string' || typeof value.at !== 'number' || !Array.isArray(value.data?.items)) return null
    return { data: value.data, title: typeof value.title === 'string' ? value.title : null, baseHash: value.baseHash, at: value.at }
  } catch {
    return null
  }
}

/** False when it couldn't be kept (no storage, or it is full). */
export function writeDraft(id: string, draft: SketchDraft): boolean {
  try {
    localStorage.setItem(draftKey(id), JSON.stringify(draft))
    return true
  } catch {
    return false
  }
}

export function clearDraft(id: string): void {
  try {
    localStorage.removeItem(draftKey(id))
  } catch {
    // No storage: nothing was kept.
  }
}

/**
 * What to do with a kept draft when the sketch opens: `resume` (the server still has the
 * version it was drawn on: save it), `conflict` (the file changed since, but the draft is
 * newer: let the user choose) or `drop` (the server's version is newer).
 */
export function draftOutcome(draft: SketchDraft, server: { hash: string; updated_at: string }): 'resume' | 'conflict' | 'drop' {
  if (draft.baseHash === server.hash) return 'resume'
  return draft.at > Date.parse(server.updated_at) ? 'conflict' : 'drop'
}
