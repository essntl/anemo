/**
 * Export and import of the appearance as a small JSON file. Uploaded files (fonts,
 * backgrounds) are not in it, only their ids: on the same server they still work; on
 * another one, what it doesn't have goes back to the default.
 */
import { isHex } from '@/lib/color'
import { type Appearance, type Background, type CustomGradient, DEFAULT_APPEARANCE, DEFAULT_BACKGROUND, DEFAULT_CUSTOM_GRADIENT } from './apply'
import { CODE_FONTS, customFontId, UI_FONTS } from './fonts'
import { WIDTH_PAGES } from './fullWidthPages'
import { GRADIENTS } from './gradients'

const FORMAT = 'anemo.appearance'
const VERSION = 1

export function exportJson(a: Appearance): string {
  return JSON.stringify({ format: FORMAT, version: VERSION, appearance: a }, null, 2)
}

export class ImportError extends Error {}

function oneOf<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

function between(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.min(max, Math.max(min, value))) : fallback
}

/** The pages' own full-width choices: only known pages, only true or false. */
function widthPages(value: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  if (!value || typeof value !== 'object') return out
  for (const [k, v] of Object.entries(value)) if ((WIDTH_PAGES as readonly string[]).includes(k) && typeof v === 'boolean') out[k] = v
  return out
}

function customGradient(value: unknown): CustomGradient {
  const v = (typeof value === 'object' && value ? value : {}) as Record<string, unknown>
  const d = DEFAULT_CUSTOM_GRADIENT
  const colors = Array.isArray(v.colors) ? v.colors.filter((c): c is string => typeof c === 'string' && isHex(c)).map((c) => c.toLowerCase()) : []
  return {
    colors: colors.length >= 2 && colors.length <= 4 ? colors : d.colors,
    style: oneOf(v.style, ['drift', 'linear'] as const, d.style),
    angle: between(v.angle, 0, 359, d.angle),
    speed: oneOf(v.speed, ['slow', 'normal', 'fast'] as const, d.speed),
  }
}

/**
 * Read an exported file. Every value is checked against what the settings allow; one
 * that isn't allowed, or an upload that isn't in `uploadIds`, gets the default.
 * Throws ImportError when the text isn't an appearance file at all.
 */
export function parseImport(text: string, uploadIds: readonly string[]): Appearance {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new ImportError('not JSON')
  }
  const file = data as { format?: unknown; appearance?: unknown }
  if (!file || file.format !== FORMAT || typeof file.appearance !== 'object' || !file.appearance) {
    throw new ImportError('not an appearance file')
  }
  const v = file.appearance as Record<string, unknown>
  const bg = (typeof v.background === 'object' && v.background ? v.background : {}) as Record<string, unknown>
  const d = DEFAULT_APPEARANCE

  const font = (value: unknown, list: { id: string }[]): string => {
    if (typeof value !== 'string') return 'default'
    const custom = customFontId(value)
    if (custom) return uploadIds.includes(custom) ? value : 'default'
    return list.some((f) => f.id === value) ? value : 'default'
  }
  const assetId = typeof bg.asset_id === 'string' && uploadIds.includes(bg.asset_id) ? bg.asset_id : null
  let kind = oneOf<Background['kind']>(bg.kind, ['none', 'gradient', 'upload'], 'none')
  if (kind === 'upload' && !assetId) kind = 'none'

  return {
    mode: oneOf(v.mode, ['light', 'dark', 'system'] as const, d.mode),
    accent: typeof v.accent === 'string' && isHex(v.accent) ? v.accent.toLowerCase() : d.accent,
    density: oneOf(v.density, ['comfortable', 'compact'] as const, d.density),
    tint: typeof v.tint === 'string' && isHex(v.tint) ? v.tint.toLowerCase() : null,
    tint_strength: between(v.tint_strength, 0, 100, d.tint_strength),
    ui_font: font(v.ui_font, UI_FONTS),
    code_font: font(v.code_font, CODE_FONTS),
    background: {
      kind,
      gradient: oneOf<Background['gradient']>(bg.gradient, [...GRADIENTS.map((g) => g.id), 'custom'], DEFAULT_BACKGROUND.gradient),
      custom_gradient: customGradient(bg.custom_gradient),
      asset_id: assetId,
      blur: between(bg.blur, 0, 40, DEFAULT_BACKGROUND.blur),
      dim: between(bg.dim, 0, 90, DEFAULT_BACKGROUND.dim),
      fit: oneOf(bg.fit, ['cover', 'contain', 'tile'] as const, DEFAULT_BACKGROUND.fit),
      animate_on_phones: bg.animate_on_phones === true,
    },
    glass: v.glass === true,
    glass_strength: between(v.glass_strength, 0, 100, d.glass_strength),
    full_width: v.full_width === true,
    full_width_pages: widthPages(v.full_width_pages),
  }
}
