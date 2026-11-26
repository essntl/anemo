/**
 * Keeping a drawing within what the server accepts (backend/app/features/documents/sketch.py):
 * the points of a new stroke rounded, thinned out and split at the per-stroke limit, and
 * a check before anything is added, so the editor never produces a drawing that can't be saved.
 */
import { t } from '@/lib/i18n'
import { isStroke, isText, LIMITS, roundCoord, roundPressure, type SketchItem } from '../model'
import { thinPoints } from './geometry'

/** Room left in the file for the Markdown around the drawing (title, properties, transcription). */
const FILE_HEADROOM = 128 * 1024

/** Rounds (x to 0.1, pressure to 0.01) and drops points that land on the one before. */
export function roundPoints(points: readonly number[]): number[] {
  const out: number[] = []
  for (let i = 0; i < points.length; i += 3) {
    const x = roundCoord(points[i]), y = roundCoord(points[i + 1]), p = roundPressure(points[i + 2])
    const n = out.length
    if (n >= 3 && out[n - 3] === x && out[n - 2] === y) {
      out[n - 1] = Math.max(out[n - 1], p)
      continue
    }
    out.push(x, y, p)
  }
  return out
}

/** Splits flat points into parts of at most `max` points; each part starts where the last ended. */
export function splitPoints(points: readonly number[], max: number = LIMITS.pointsPerStroke): number[][] {
  const n = points.length / 3
  if (n <= max) return [points.slice()]
  const parts: number[][] = []
  for (let start = 0; start < n - 1; start += max - 1) {
    parts.push(points.slice(start * 3, Math.min(n, start + max) * 3))
  }
  return parts
}

/**
 * The points of a finished stroke as they are saved: thinned out (`tolerance` in sheet
 * units), rounded and split into parts the server accepts.
 */
export function prepareStrokePoints(raw: readonly number[], tolerance = 0.4): number[][] {
  if (raw.length < 3) return []
  return splitPoints(roundPoints(thinPoints(raw, tolerance)))
}

/** The number of points in all strokes. */
export function countPoints(items: readonly SketchItem[]): number {
  let n = 0
  for (const item of items) if (isStroke(item)) n += item.points.length / 3
  return n
}

export function countTextChars(items: readonly SketchItem[]): number {
  let n = 0
  for (const item of items) if (isText(item)) n += item.text.length
  return n
}

/** UTF-8 length of a string, without allocating. */
export function utf8Length(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

const bytesCache = new WeakMap<SketchItem, number>()

/**
 * The bytes one item takes in the saved JSON (one item a line). The server writes whole
 * numbers as floats ("12.0"), two bytes more than JavaScript does; counted here too.
 */
export function itemBytes(item: SketchItem): number {
  let n = bytesCache.get(item)
  if (n === undefined) {
    const numbers = isStroke(item) ? item.points : Object.values(item).filter((v): v is number => typeof v === 'number')
    let whole = 0
    for (const v of numbers) if (Number.isInteger(v)) whole++
    n = utf8Length(JSON.stringify(item)) + 2 + whole * 2
    bytesCache.set(item, n)
  }
  return n
}

export const estimateBytes = (items: readonly SketchItem[]): number => items.reduce((sum, item) => sum + itemBytes(item), 200)

export type LimitProblem = 'items' | 'points' | 'text' | 'size' | 'pages'

/** What would break a limit if `items` became the drawing's items (null: nothing). */
export function checkItems(items: readonly SketchItem[]): LimitProblem | null {
  if (items.length > LIMITS.items) return 'items'
  if (countPoints(items) > LIMITS.points) return 'points'
  if (countTextChars(items) > LIMITS.totalTextChars) return 'text'
  if (estimateBytes(items) > LIMITS.fileBytes - FILE_HEADROOM) return 'size'
  return null
}

const MEASURES: Record<Exclude<LimitProblem, 'pages'>, (items: readonly SketchItem[]) => number> = {
  items: (items) => items.length,
  points: countPoints,
  text: countTextChars,
  size: estimateBytes,
}

/**
 * Whether going from `before` to `after` breaks a limit. A drawing that is already past
 * one (made elsewhere, or by an older version) may still shrink: only a change that makes
 * it worse is refused.
 */
export function checkChange(before: readonly SketchItem[], after: readonly SketchItem[]): LimitProblem | null {
  const problem = checkItems(after)
  if (!problem || problem === 'pages') return problem
  const measure = MEASURES[problem]
  return measure(after) > measure(before) ? problem : null
}

/** Whether a sheet may have this many pages. */
export const checkPages = (pages: number): LimitProblem | null => (Number.isInteger(pages) && pages >= 1 && pages <= LIMITS.pages ? null : 'pages')

/** What to tell the user when a change is refused. */
export function limitMessage(problem: LimitProblem): string {
  switch (problem) {
    case 'items':
      return t('This sketch is full: it can hold {n} items at most. Erase something, or start another sketch.', { n: LIMITS.items.toLocaleString() })
    case 'points':
      return t('This sketch is full: there is no room for more strokes. Erase something, or start another sketch.')
    case 'text':
      return t('A sketch can hold {n} characters of text at most.', { n: LIMITS.totalTextChars.toLocaleString() })
    case 'size':
      return t('This sketch is too large to save. Erase something, or start another sketch.')
    case 'pages':
      return t('A sketch can have {n} pages at most.', { n: LIMITS.pages })
  }
}
