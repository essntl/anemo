/**
 * Colours: the theme the sheet is drawn in ("ink", the paper, the pattern, the pages)
 * and the palette of the toolbar. The theme is read from the app's CSS variables
 * (styles/tokens.css) so the sheet follows light and dark; the preview image always uses
 * LIGHT_THEME, which needs no CSS.
 */
import { msg } from '@/lib/i18n'
import { INK } from '../model'

export interface SketchTheme {
  /** What "ink" is drawn in: the theme's text colour. */
  ink: string
  /** Around the pages (pages layout). */
  desk: string
  /** The sheet itself (the infinite layout) and the pages. */
  paper: string
  /** Grid, dots and ruled lines. */
  pattern: string
  pageBorder: string
  /** The lasso and the selection box. */
  selection: string
  dark: boolean
}

/** The light theme with fixed values (tokens.css), for the preview image. */
export const LIGHT_THEME: SketchTheme = {
  ink: '#15171c',
  desk: '#ffffff',
  paper: '#ffffff',
  pattern: 'rgba(15, 20, 30, 0.12)',
  pageBorder: 'rgba(15, 20, 30, 0.16)',
  selection: '#2a6df4',
  dark: false,
}

/** The theme the page shows now. */
export function readTheme(root: HTMLElement = document.documentElement): SketchTheme {
  // A variable may hold any CSS colour (color-mix(), var()…); a probe element resolves it
  // to rgb(), which a canvas understands.
  const probe = document.createElement('span')
  probe.style.display = 'none'
  root.appendChild(probe)
  const v = (name: string, fallback: string) => {
    probe.style.color = ''
    probe.style.color = `var(${name}, ${fallback})`
    const value = getComputedStyle(probe).color.trim()
    return value && !value.startsWith('var(') ? value : fallback
  }
  try {
    return {
      ink: v('--text', LIGHT_THEME.ink),
      desk: v('--bg', '#eceef2'),
      paper: v('--surface', LIGHT_THEME.paper),
      pattern: v('--border', LIGHT_THEME.pattern),
      pageBorder: v('--border-strong', LIGHT_THEME.pageBorder),
      selection: v('--accent', LIGHT_THEME.selection),
      dark: root.dataset.theme === 'dark',
    }
  } finally {
    probe.remove()
  }
}

/** The colour to draw `color` in: "ink" becomes the theme's text colour. */
export const resolveColor = (color: string, theme: SketchTheme): string => (color === INK ? theme.ink : color)

export interface Swatch {
  color: string
  label: string
}

/**
 * The palette. Colours are saved as they are, so each reads on both a light and a dark
 * sheet; "ink" turns light on a dark sheet.
 */
export const PALETTE: Swatch[] = [
  { color: INK, label: msg('Ink') },
  { color: '#e03131', label: msg('Red') },
  { color: '#f08c00', label: msg('Orange') },
  { color: '#f5c400', label: msg('Yellow') },
  { color: '#2f9e44', label: msg('Green') },
  { color: '#1c7ed6', label: msg('Blue') },
  { color: '#7048e8', label: msg('Purple') },
  { color: '#d6336c', label: msg('Pink') },
  { color: '#868e96', label: msg('Grey') },
]

/** The highlighter's own default: yellow. */
export const HIGHLIGHTER_COLOR = '#f5c400'
