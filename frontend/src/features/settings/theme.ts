/**
 * Theme state: light/dark/system mode, accent color and density.
 *
 * The values are cached in localStorage so the first paint is correct (see the
 * inline script in index.html). Once logged in, the server copy in
 * Settings > Appearance is the source of truth: `hydrate()` loads it, and
 * user edits via `set()` bump `editVersion`, which triggers an autosave
 * (see useAppearanceSync).
 */
import { create } from 'zustand'

export type ThemeMode = 'light' | 'dark' | 'system'
export type Density = 'comfortable' | 'compact'

export interface Appearance {
  mode: ThemeMode
  accent: string
  density: Density
}

export const DEFAULT_APPEARANCE: Appearance = {
  mode: 'system',
  accent: '#3478f6',
  density: 'comfortable',
}

export const ACCENT_PRESETS = [
  '#3478f6', // blue
  '#6b5cf6', // violet
  '#e0457b', // pink
  '#f06a2c', // orange
  '#e6a700', // amber
  '#1f9d6b', // green
  '#0fa3b1', // teal
  '#5f6b7a', // graphite
]

const STORAGE_KEY = 'aiw.appearance'

function loadCached(): Appearance {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...DEFAULT_APPEARANCE, ...JSON.parse(raw) }
  } catch {
    // Storage may be unavailable (private mode); fall back to defaults.
  }
  return DEFAULT_APPEARANCE
}

/** Pick black or white text for good contrast on the accent color. */
export function contrastText(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return '#ffffff'
  const n = parseInt(m[1], 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return luminance > 0.45 ? '#111111' : '#ffffff'
}

export function resolveMode(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** Write appearance to the <html> element; all components update via CSS variables. */
export function applyAppearance(a: Appearance): void {
  const root = document.documentElement
  root.classList.add('theme-transition')
  root.dataset.theme = resolveMode(a.mode)
  root.dataset.density = a.density
  root.style.setProperty('--accent', a.accent)
  root.style.setProperty('--accent-contrast', contrastText(a.accent))
  // The phone's status bar / browser toolbar takes the page background colour.
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim()
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg)
  window.setTimeout(() => root.classList.remove('theme-transition'), 250)
}

interface ThemeStore extends Appearance {
  /** Incremented on every user edit (not on hydrate), so only real edits are saved. */
  editVersion: number
  /** User edit: apply, cache, and mark for saving to the server. */
  set: (patch: Partial<Appearance>) => void
  /** Load values from the server without triggering a save. */
  hydrate: (a: Appearance) => void
}

function persist(a: Appearance) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(a))
  } catch {
    // ignore
  }
  applyAppearance(a)
}

export const useThemeStore = create<ThemeStore>((set, get) => ({
  ...loadCached(),
  editVersion: 0,
  set: (patch) => {
    set({ ...patch, editVersion: get().editVersion + 1 })
    const { mode, accent, density } = get()
    persist({ mode, accent, density })
  },
  hydrate: (a) => {
    set({ mode: a.mode, accent: a.accent, density: a.density })
    persist(a)
  },
}))

/** Re-apply when the OS theme changes and the user chose "system". */
export function watchSystemTheme(): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const onChange = () => {
    const { mode, accent, density } = useThemeStore.getState()
    if (mode === 'system') applyAppearance({ mode, accent, density })
  }
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}
