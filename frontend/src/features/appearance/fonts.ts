/**
 * The fonts you can choose in Settings > Appearance: the default, fonts that come with
 * the app (npm @fontsource packages, bundled by Vite, so nothing is fetched from Google
 * Fonts or any other site), fonts of the operating system, and uploaded font files.
 *
 * The choice is applied as `--font-ui` / `--font-code` on <html> (see apply.ts), which
 * `font-sans` / `font-mono` in app.css read. A bundled font's CSS is imported only when
 * it is chosen; an uploaded one is loaded with the FontFace API.
 */
import { msg } from '@/lib/i18n'

export type FontSlot = 'ui' | 'code'

export interface FontChoice {
  id: string
  label: string
  group: 'default' | 'bundled' | 'system'
  /** The CSS font-family list; null for the default (app.css's own). */
  stack: string | null
  /** Imports the font's @font-face rules (bundled fonts). */
  load?: () => Promise<unknown>
}

const SANS_FALLBACK = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
const MONO_FALLBACK = "ui-monospace, 'Cascadia Code', Menlo, Consolas, monospace"

export const UI_FONTS: FontChoice[] = [
  { id: 'default', label: msg('Default'), group: 'default', stack: null },
  {
    id: 'inter', label: 'Inter', group: 'bundled', stack: `'Inter Variable', ${SANS_FALLBACK}`,
    load: () => import('@fontsource-variable/inter'),
  },
  {
    id: 'plex-sans', label: 'IBM Plex Sans', group: 'bundled', stack: `'IBM Plex Sans', ${SANS_FALLBACK}`,
    load: () => Promise.all([
      import('@fontsource/ibm-plex-sans/400.css'),
      import('@fontsource/ibm-plex-sans/500.css'),
      import('@fontsource/ibm-plex-sans/600.css'),
      import('@fontsource/ibm-plex-sans/700.css'),
    ]),
  },
  {
    id: 'nunito', label: 'Nunito', group: 'bundled', stack: `'Nunito Variable', ${SANS_FALLBACK}`,
    load: () => import('@fontsource-variable/nunito'),
  },
  {
    id: 'source-serif', label: 'Source Serif 4', group: 'bundled', stack: "'Source Serif 4 Variable', Georgia, serif",
    load: () => import('@fontsource-variable/source-serif-4'),
  },
  { id: 'system', label: msg('System font'), group: 'system', stack: SANS_FALLBACK },
  { id: 'serif', label: msg('System serif'), group: 'system', stack: "ui-serif, Georgia, 'Times New Roman', serif" },
  { id: 'rounded', label: msg('System rounded'), group: 'system', stack: `ui-rounded, 'SF Pro Rounded', ${SANS_FALLBACK}` },
]

export const CODE_FONTS: FontChoice[] = [
  { id: 'default', label: msg('Default'), group: 'default', stack: null },
  {
    id: 'jetbrains-mono', label: 'JetBrains Mono', group: 'bundled', stack: `'JetBrains Mono Variable', ${MONO_FALLBACK}`,
    load: () => import('@fontsource-variable/jetbrains-mono'),
  },
  {
    id: 'fira-code', label: 'Fira Code', group: 'bundled', stack: `'Fira Code Variable', ${MONO_FALLBACK}`,
    load: () => import('@fontsource-variable/fira-code'),
  },
  {
    id: 'plex-mono', label: 'IBM Plex Mono', group: 'bundled', stack: `'IBM Plex Mono', ${MONO_FALLBACK}`,
    load: () => Promise.all([import('@fontsource/ibm-plex-mono/400.css'), import('@fontsource/ibm-plex-mono/500.css')]),
  },
  { id: 'system', label: msg('System monospace'), group: 'system', stack: MONO_FALLBACK },
]

const CUSTOM = 'custom:'

/** The asset id of an uploaded font choice ("custom:<id>"), else null. */
export function customFontId(choice: string): string | null {
  return choice.startsWith(CUSTOM) ? choice.slice(CUSTOM.length) : null
}

export function customFontChoice(assetId: string): string {
  return `${CUSTOM}${assetId}`
}

/** The family name an uploaded font is registered under: our own, never the file's. */
function customFamily(assetId: string): string {
  return `AnemoFont-${assetId.replace(/[^0-9a-f]/gi, '')}`
}

/** The font-family list for a choice; null means "leave the default". */
export function fontStack(choice: string, slot: FontSlot): string | null {
  const custom = customFontId(choice)
  if (custom) return `'${customFamily(custom)}', ${slot === 'ui' ? SANS_FALLBACK : MONO_FALLBACK}`
  const list = slot === 'ui' ? UI_FONTS : CODE_FONTS
  return list.find((f) => f.id === choice)?.stack ?? null
}

const loading = new Map<string, Promise<unknown>>()

/**
 * Make the font of a choice available (once per page load). Failing quietly is fine:
 * the fallback fonts of the stack are used then.
 */
export function loadFont(choice: string, slot: FontSlot): Promise<unknown> {
  const key = `${slot}:${choice}`
  let done = loading.get(key)
  if (!done) {
    done = startLoading(choice, slot).catch(() => undefined)
    loading.set(key, done)
  }
  return done
}

function startLoading(choice: string, slot: FontSlot): Promise<unknown> {
  const custom = customFontId(choice)
  if (custom) {
    if (typeof FontFace === 'undefined') return Promise.resolve()
    // One weight range, so the browser uses the file for bold too instead of skipping it.
    const face = new FontFace(customFamily(custom), `url(/api/appearance/assets/${encodeURIComponent(custom)}/content)`, {
      weight: '100 900',
      display: 'swap',
    })
    document.fonts.add(face)
    return face.load()
  }
  const list = slot === 'ui' ? UI_FONTS : CODE_FONTS
  return list.find((f) => f.id === choice)?.load?.() ?? Promise.resolve()
}
