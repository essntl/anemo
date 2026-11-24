/**
 * Turns the appearance settings into what the page uses: CSS variables (for light and
 * for dark) and data attributes on <html>. Components never see the settings; they use
 * the semantic Tailwind colours (`bg-surface`, `bg-accent`, …), which read these variables.
 *
 * The result is also cached in localStorage under CSS_CACHE_KEY. The inline script in
 * index.html copies it onto <html> before the app's JS has loaded, so a reload shows
 * your colours from the first frame. That script has no logic of its own: everything
 * is worked out here.
 */
import type { Schemas } from '@/api/client'
import { AA_TEXT, AA_UI, accentShades, contrast, isHex, mix } from '@/lib/color'
import { fontStack } from './fonts'

/** The server's settings; fields it fills with a default are always there. */
export type CustomGradient = Required<Schemas['CustomGradient']>
export type Background = Required<Omit<Schemas['AppearanceBackground'], 'custom_gradient'>> & { custom_gradient: CustomGradient }
export type Appearance = Required<Omit<Schemas['AppearanceSettings'], 'background'>> & { background: Background }
export type ThemeMode = Appearance['mode']
export type Density = Appearance['density']
export type Resolved = 'light' | 'dark'

export const DEFAULT_ACCENT = '#2a6df4'

/** The same defaults as the server's CustomGradient. */
export const DEFAULT_CUSTOM_GRADIENT: CustomGradient = {
  colors: ['#2a6df4', '#00c2d4', '#c04fe0'],
  style: 'drift',
  angle: 135,
  speed: 'normal',
}

export const DEFAULT_BACKGROUND: Background = {
  kind: 'none',
  gradient: 'aurora',
  custom_gradient: DEFAULT_CUSTOM_GRADIENT,
  asset_id: null,
  blur: 0,
  dim: 35,
  fit: 'cover',
  animate_on_phones: false,
}

/** The same defaults as the server's AppearanceSettings. */
export const DEFAULT_APPEARANCE: Appearance = {
  mode: 'system',
  accent: DEFAULT_ACCENT,
  density: 'comfortable',
  tint: null,
  tint_strength: 40,
  ui_font: 'default',
  code_font: 'default',
  background: DEFAULT_BACKGROUND,
  glass: false,
  glass_strength: 50,
}

/** As the server sends it (or an older cache has it): fields with a default may be missing. */
export type StoredAppearance = Partial<Schemas['AppearanceSettings']>

/** Fill in what an older or partial value (a cache, the server's answer) leaves out. */
export function withDefaults(value: StoredAppearance | null | undefined): Appearance {
  const v = value ?? {}
  const background = {
    ...DEFAULT_BACKGROUND,
    ...v.background,
    asset_id: v.background?.asset_id ?? null,
    custom_gradient: { ...DEFAULT_CUSTOM_GRADIENT, ...v.background?.custom_gradient },
  }
  return { ...DEFAULT_APPEARANCE, ...v, tint: v.tint ?? null, background }
}

type Surface = 'bg' | 'surface' | 'surface-2' | 'surface-hover' | 'card'

/** The theme's own colours: a copy of tokens.css (apply.test.ts checks they match). */
export const BASE: Record<Resolved, Record<Surface | 'text' | 'text-muted', string>> = {
  light: {
    bg: '#eceef2', surface: '#ffffff', 'surface-2': '#e9ebf0', 'surface-hover': '#dfe2e8', card: '#ffffff',
    text: '#15171c', 'text-muted': '#3d434e',
  },
  dark: {
    bg: '#0e1014', surface: '#15181e', 'surface-2': '#1c2027', 'surface-hover': '#242933', card: '#181b22',
    text: '#eceef2', 'text-muted': '#bcc2cd',
  },
}

/** How much of the tint goes into each surface at full strength: the page most, cards
 *  least, so text on cards keeps its contrast. */
const TINT_SHARE: Record<Surface, number> = {
  bg: 0.35,
  'surface-2': 0.28,
  'surface-hover': 0.3,
  surface: 0.1,
  card: 0.1,
}

/** The surface colours with the tint mixed in (the theme's own without a tint). */
export function surfaces(a: Appearance, mode: Resolved): Record<Surface, string> {
  const base = BASE[mode]
  const out = {} as Record<Surface, string>
  for (const name of Object.keys(TINT_SHARE) as Surface[]) {
    out[name] = a.tint && isHex(a.tint) ? mix(base[name], a.tint, TINT_SHARE[name] * (a.tint_strength / 100)) : base[name]
  }
  return out
}

/** Every variable this module may set, so one left from an earlier choice is removed. */
const MANAGED = [
  '--accent', '--accent-hover', '--accent-active', '--accent-contrast',
  '--bg', '--surface', '--surface-2', '--surface-hover', '--card',
  '--font-ui', '--font-code',
  '--glass-blur', '--glass-opacity',
]

/**
 * Frosted glass at a strength of 0–100: the blur, and how opaque the panel stays. 50 is
 * the look glass had before it had a strength. The panel never gets more see-through than
 * 70 % opaque (65 % in dark), so text on it keeps its contrast whatever is behind it.
 * Between the three points the values are interpolated in a straight line.
 */
const GLASS: Record<Resolved, { blur: [number, number, number]; opacity: [number, number, number] }> = {
  //            strength:  0   50   100
  light: { blur: [6, 18, 32], opacity: [90, 72, 70] },
  dark: { blur: [6, 18, 32], opacity: [88, 66, 65] },
}

export function glassLook(strength: number, mode: Resolved): { blur: number; opacity: number } {
  const s = Math.min(100, Math.max(0, strength))
  const at = ([a, b, c]: [number, number, number]) => (s <= 50 ? a + ((b - a) * s) / 50 : b + ((c - b) * (s - 50)) / 50)
  const { blur, opacity } = GLASS[mode]
  return { blur: Math.round(at(blur)), opacity: Math.round(at(opacity)) }
}

export type Vars = Record<string, string>

export function cssVariables(a: Appearance, mode: Resolved): Vars {
  const accent = isHex(a.accent) ? a.accent : DEFAULT_ACCENT
  const shades = accentShades(accent, mode === 'dark')
  const vars: Vars = {
    '--accent': accent,
    '--accent-hover': shades.hover,
    '--accent-active': shades.active,
    '--accent-contrast': shades.contrastText,
  }
  if (a.tint && isHex(a.tint) && a.tint_strength > 0) {
    for (const [name, value] of Object.entries(surfaces(a, mode))) vars[`--${name}`] = value
  }
  const ui = fontStack(a.ui_font, 'ui')
  if (ui) vars['--font-ui'] = ui
  const code = fontStack(a.code_font, 'code')
  if (code) vars['--font-code'] = code
  if (a.glass) {
    const glass = glassLook(a.glass_strength, mode)
    vars['--glass-blur'] = `${glass.blur}px`
    vars['--glass-opacity'] = `${glass.opacity}%`
  }
  return vars
}

export interface ContrastWarning {
  kind: 'accent-text' | 'accent-page' | 'text-surface'
  ratio: number
  needed: number
}

/** What would be hard to read with these colours in `mode` (empty: all fine). */
export function contrastWarnings(a: Appearance, mode: Resolved): ContrastWarning[] {
  const out: ContrastWarning[] = []
  const accent = isHex(a.accent) ? a.accent : DEFAULT_ACCENT
  const shades = accentShades(accent, mode === 'dark')
  const s = surfaces(a, mode)
  if (shades.textRatio < AA_TEXT) out.push({ kind: 'accent-text', ratio: shades.textRatio, needed: AA_TEXT })
  // Links, focus rings and icons in the accent colour, on the page and on cards.
  const onPage = Math.min(contrast(accent, s.bg), contrast(accent, s.card))
  if (onPage < AA_UI) out.push({ kind: 'accent-page', ratio: onPage, needed: AA_UI })
  // Secondary text is the weakest text the theme has; check it on every surface.
  const muted = BASE[mode]['text-muted']
  const onSurfaces = Math.min(...Object.values(s).map((bg) => contrast(muted, bg)))
  if (onSurfaces < AA_TEXT) out.push({ kind: 'text-surface', ratio: onSurfaces, needed: AA_TEXT })
  return out
}

/** What index.html's inline script needs to paint the first frame. */
export interface CachedLook {
  mode: ThemeMode
  density: Density
  glass: boolean
  /** A background is chosen: the chat panel lets it show through. */
  background: boolean
  light: Vars
  dark: Vars
}

export const CSS_CACHE_KEY = 'anemo.appearance.css'

export function lookFor(a: Appearance): CachedLook {
  return {
    mode: a.mode,
    density: a.density,
    glass: a.glass,
    background: a.background.kind !== 'none',
    light: cssVariables(a, 'light'),
    dark: cssVariables(a, 'dark'),
  }
}

export function resolveMode(mode: ThemeMode): Resolved {
  if (mode !== 'system') return mode
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** Write a look onto <html>. */
export function applyLook(look: CachedLook, resolved: Resolved, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = resolved
  root.dataset.density = look.density
  root.dataset.glass = look.glass ? 'on' : 'off'
  root.dataset.background = look.background ? 'on' : 'off'
  for (const name of MANAGED) root.style.removeProperty(name)
  for (const [name, value] of Object.entries(look[resolved])) root.style.setProperty(name, value)
}

export function cacheLook(look: CachedLook): void {
  try {
    localStorage.setItem(CSS_CACHE_KEY, JSON.stringify(look))
  } catch {
    // Storage may be unavailable (private mode): the first frame then uses the defaults.
  }
}
