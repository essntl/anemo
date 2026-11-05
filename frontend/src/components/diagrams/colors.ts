/**
 * The app's colors as plain hex values, for drawings that leave the page (a downloaded
 * SVG or PNG) or that a library mixes itself (Mermaid only understands hex/rgb). Tokens
 * are often `color-mix()` or have transparency, so each is drawn onto a 1×1 canvas over
 * the surface color and read back.
 */
import { useEffect, useState } from 'react'

export interface Palette {
  dark: boolean
  surface: string
  surface2: string
  surfaceHover: string
  text: string
  muted: string
  subtle: string
  border: string
  accent: string
  /** Categorical colors for series and slices. */
  series: string[]
  font: string
}

/** Used where nothing can be measured (tests, server). */
export const FALLBACK_PALETTE: Palette = {
  dark: false,
  surface: '#ffffff',
  surface2: '#eef0f4',
  surfaceHover: '#e7e9ee',
  text: '#15171c',
  muted: '#6a7080',
  subtle: '#9aa0ad',
  border: '#dcdee3',
  accent: '#3478f6',
  series: ['#3478f6', '#e07a2e', '#2a9d68', '#8b5cf6', '#d6457a', '#1597a8'],
  font: 'system-ui, sans-serif',
}

const SERIES_TOKENS = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6']

function hex(n: number): string {
  return n.toString(16).padStart(2, '0')
}

/** Reads the palette from the page's current theme. */
export function readPalette(): Palette {
  // jsdom (tests) has no canvas.
  if (typeof document === 'undefined' || /jsdom/i.test(navigator.userAgent)) return FALLBACK_PALETTE
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  let ctx: CanvasRenderingContext2D | null = null
  try {
    ctx = canvas.getContext('2d', { willReadFrequently: true })
  } catch {
    ctx = null
  }
  if (!ctx) return FALLBACK_PALETTE
  const probe = document.createElement('span')
  probe.style.display = 'none'
  document.body.appendChild(probe)
  const computed = (token: string) => {
    probe.style.color = `var(${token})`
    return getComputedStyle(probe).color
  }
  const surfaceColor = computed('--surface')
  const resolve = (token: string, fallback: string) => {
    const value = computed(token)
    if (!value) return fallback
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = surfaceColor || '#ffffff'
    ctx.fillRect(0, 0, 1, 1)
    ctx.fillStyle = value
    ctx.fillRect(0, 0, 1, 1)
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
    return `#${hex(r)}${hex(g)}${hex(b)}`
  }
  const f = FALLBACK_PALETTE
  const palette: Palette = {
    dark: document.documentElement.dataset.theme === 'dark',
    surface: resolve('--surface', f.surface),
    surface2: resolve('--surface-2', f.surface2),
    surfaceHover: resolve('--surface-hover', f.surfaceHover),
    text: resolve('--text', f.text),
    muted: resolve('--text-muted', f.muted),
    subtle: resolve('--text-subtle', f.subtle),
    border: resolve('--border-strong', f.border),
    accent: resolve('--accent', f.accent),
    series: SERIES_TOKENS.map((t, i) => resolve(t, f.series[i])),
    font: getComputedStyle(document.body).fontFamily || f.font,
  }
  probe.remove()
  return palette
}

/**
 * The palette, read again whenever the theme or the accent color changes (both are
 * set on <html>: `data-theme` and an inline `--accent`).
 */
export function usePalette(): Palette {
  const [palette, setPalette] = useState<Palette>(() => readPalette())
  useEffect(() => {
    const update = () => setPalette(readPalette())
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] })
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    media?.addEventListener?.('change', update)
    return () => {
      observer.disconnect()
      media?.removeEventListener?.('change', update)
    }
  }, [])
  return palette
}
