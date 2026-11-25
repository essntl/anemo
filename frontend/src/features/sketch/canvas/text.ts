/**
 * Laying out a text box: its lines (wrapped at `width` when it has one) and its size.
 * The same layout serves drawing (render.ts), hit tests (geometry.ts) and the textarea
 * shown while you type, so the three agree.
 */
import type { TextBox } from '../model'

/** The font of sketch text; the same in the app and in the preview image. */
export const FONT_FAMILY = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
export const LINE_HEIGHT = 1.25

export const fontFor = (size: number): string => `${size}px ${FONT_FAMILY}`

/** The width of `text` at font size `size`. */
export type Measure = (text: string, size: number) => number

/** A rough width without a canvas (tests, jsdom): about half an em a character. */
export const approximateMeasure: Measure = (text, size) => text.length * size * 0.55

let shared: Measure | null = null

/** Measures with a real canvas when the browser has one, roughly otherwise. */
export function defaultMeasure(): Measure {
  if (shared) return shared
  const ctx = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1).getContext('2d') : null
  if (!ctx) return approximateMeasure
  const cache = new Map<string, number>()
  shared = (text, size) => {
    // Widths grow linearly with the font size: measure once at 100 px.
    let at100 = cache.get(text)
    if (at100 === undefined) {
      ctx.font = fontFor(100)
      at100 = ctx.measureText(text).width
      if (cache.size > 5000) cache.clear()
      cache.set(text, at100)
    }
    return (at100 * size) / 100
  }
  return shared
}

export interface TextLayout {
  lines: string[]
  width: number
  height: number
  lineHeight: number
}

/** Breaks one paragraph into lines no wider than `max` (a word longer than that gets its own line). */
function wrapParagraph(paragraph: string, size: number, max: number, measure: Measure): string[] {
  const words = paragraph.split(/(\s+)/)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    if (word === '') continue
    const candidate = line + word
    if (line !== '' && measure(candidate.trimEnd(), size) > max && !/^\s+$/.test(word)) {
      lines.push(line.trimEnd())
      line = word
    } else {
      line = candidate
    }
  }
  lines.push(line.trimEnd())
  return lines
}

export function layoutText(box: Pick<TextBox, 'text' | 'size' | 'width'>, measure: Measure = defaultMeasure()): TextLayout {
  const lineHeight = box.size * LINE_HEIGHT
  const paragraphs = box.text.split('\n')
  const lines = box.width ? paragraphs.flatMap((p) => wrapParagraph(p, box.size, box.width!, measure)) : paragraphs
  const widest = Math.max(0, ...lines.map((l) => measure(l, box.size)))
  return {
    lines,
    width: box.width ? Math.max(box.width, widest) : widest,
    height: Math.max(1, lines.length) * lineHeight,
    lineHeight,
  }
}
