/**
 * Colour maths for the appearance settings: parsing, mixing and WCAG contrast.
 *
 * Mixing happens in OKLab, a space where equal steps look equally different to the eye
 * (the CSS `color-mix(in oklch, …)` the theme used before works the same way), so a
 * hover shade 12 % toward black looks as much darker for yellow as for blue.
 * Contrast follows WCAG 2.x: relative luminance, ratio (L1 + 0.05) / (L2 + 0.05).
 */

export interface Rgb {
  r: number
  g: number
  b: number
}

/** WCAG AA: body text needs 4.5:1, large text and UI parts (outlines, icons) 3:1. */
export const AA_TEXT = 4.5
export const AA_UI = 3

const HEX = /^#?([0-9a-f]{6})$/i

/** "#2a6df4" (or without "#") → { r, g, b } in 0–255; null when it isn't a 6-digit hex colour. */
export function parseHex(hex: string): Rgb | null {
  const m = HEX.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

export function isHex(value: string): boolean {
  return parseHex(value) !== null
}

export function toHex({ r, g, b }: Rgb): string {
  const part = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`
}

// sRGB channel (0–1) ↔ linear light.
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const fromLinear = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const c = parseHex(hex)
  if (!c) return 0
  const [r, g, b] = [c.r, c.g, c.b].map((v) => toLinear(v / 255))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two colours, from 1 (same) to 21 (black on white). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

type Lab = [number, number, number]

// OKLab, from https://bottosson.github.io/posts/oklab/
function toOklab({ r, g, b }: Rgb): Lab {
  const [lr, lg, lb] = [r, g, b].map((v) => toLinear(v / 255))
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

function fromOklab([L, a, b]: Lab): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
  const [r, g, bl] = lin.map((c) => fromLinear(Math.min(1, Math.max(0, c))) * 255)
  return { r, g, b: bl }
}

/** `amount` (0–1) of `b` mixed into `a`, in OKLab. Invalid input gives `a` unchanged. */
export function mix(a: string, b: string, amount: number): string {
  const ca = parseHex(a)
  const cb = parseHex(b)
  if (!ca || !cb) return a
  const t = Math.min(1, Math.max(0, amount))
  const [la, lb] = [toOklab(ca), toOklab(cb)]
  return toHex(fromOklab([0, 1, 2].map((i) => la[i] + (lb[i] - la[i]) * t) as Lab))
}

export const WHITE = '#ffffff'
export const DARK_TEXT = '#111111'

/**
 * The text colour (of `candidates`) that reads best on every one of `backgrounds`:
 * the one whose worst contrast is highest. With one background, simply the best.
 */
export function bestTextOn(backgrounds: string[], candidates: string[] = [WHITE, DARK_TEXT]): { color: string; ratio: number } {
  let best = { color: candidates[0], ratio: 0 }
  for (const color of candidates) {
    const ratio = Math.min(...backgrounds.map((bg) => contrast(color, bg)))
    if (ratio > best.ratio) best = { color, ratio }
  }
  return best
}

export interface AccentShades {
  accent: string
  /** Under the pointer. */
  hover: string
  /** While pressed. */
  active: string
  /** Text and icons on the accent (buttons): black or white, whichever has the higher
   *  WCAG contrast on it. */
  contrastText: string
  /** The contrast of `contrastText` on the accent. */
  textRatio: number
}

/**
 * Shades of an accent colour. In light mode hover and pressed go darker, in dark mode
 * lighter (toward the text colour), as the theme did with color-mix before.
 */
export function accentShades(accent: string, dark: boolean): AccentShades {
  const toward = dark ? WHITE : '#000000'
  const hover = mix(accent, toward, 0.12)
  const active = mix(accent, toward, 0.2)
  const text = bestTextOn([accent])
  return { accent, hover, active, contrastText: text.color, textRatio: text.ratio }
}

/**
 * `color`, moved toward `towards` (white on dark pages, black on light ones) just far
 * enough to be readable as text (WCAG 4.5:1) on every one of `backgrounds`. Unchanged
 * when it already is; the closest it can get when nothing reaches 4.5:1.
 */
export function readableOn(color: string, backgrounds: string[], towards: string): string {
  for (let step = 0; step <= 20; step++) {
    const candidate = mix(color, towards, step / 20)
    if (Math.min(...backgrounds.map((bg) => contrast(candidate, bg))) >= AA_TEXT) return candidate
  }
  return towards
}
