/**
 * Theme state: everything in Settings > Appearance (mode, accent, tint, fonts,
 * background, glass, density).
 *
 * The values are cached in localStorage so the first paint is correct (see the
 * inline script in index.html and features/appearance/apply.ts). Once logged in, the
 * server copy in Settings > Appearance is the source of truth: `hydrate()` loads it, and
 * user edits via `set()` bump `editVersion`, which triggers an autosave
 * (see useAppearanceSync). With "Use a different appearance on this device" on
 * (`deviceOnly`), this browser keeps its own copy and the server's is left alone.
 */
import { create } from 'zustand'
import {
  type Appearance,
  applyLook,
  type StoredAppearance,
  cacheLook,
  DEFAULT_APPEARANCE,
  lookFor,
  resolveMode,
  withDefaults,
} from '@/features/appearance/apply'
import { loadFont } from '@/features/appearance/fonts'
import { accentShades } from '@/lib/color'

export type { Appearance, Density, ThemeMode } from '@/features/appearance/apply'
export { DEFAULT_APPEARANCE, resolveMode } from '@/features/appearance/apply'

export const ACCENT_PRESETS = [
  '#2a6df4', // blue
  '#6b5cf6', // violet
  '#e0457b', // pink
  '#f06a2c', // orange
  '#e6a700', // amber
  '#1f9d6b', // green
  '#0fa3b1', // teal
  '#5f6b7a', // graphite
]

// Existing key: must not be renamed (CLAUDE.md), so it keeps its old prefix.
const STORAGE_KEY = 'aiw.appearance'
const DEVICE_ONLY_KEY = 'anemo.appearance.thisDevice'

function loadCached(): Appearance {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return withDefaults(JSON.parse(raw))
  } catch {
    // Storage may be unavailable (private mode); fall back to defaults.
  }
  return DEFAULT_APPEARANCE
}

function loadDeviceOnly(): boolean {
  try {
    return localStorage.getItem(DEVICE_ONLY_KEY) === '1'
  } catch {
    return false
  }
}

/** Black or white text, whichever has the higher WCAG contrast on the accent colour. */
export function contrastText(hex: string): string {
  return accentShades(hex, false).contrastText
}

/** Write appearance to the <html> element; all components update via CSS variables. */
export function applyAppearance(a: Appearance): void {
  const root = document.documentElement
  root.classList.add('theme-transition')
  const look = lookFor(a)
  applyLook(look, resolveMode(a.mode), root)
  cacheLook(look)
  void loadFont(a.ui_font, 'ui')
  void loadFont(a.code_font, 'code')
  // The phone's status bar / browser toolbar takes the page background colour.
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim()
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg)
  window.setTimeout(() => root.classList.remove('theme-transition'), 250)
}

/** The appearance fields of the store, without its methods. */
export function currentAppearance(): Appearance {
  const { mode, accent, density, tint, tint_strength, ui_font, code_font, background, glass } = useThemeStore.getState()
  return { mode, accent, density, tint, tint_strength, ui_font, code_font, background, glass }
}

interface ThemeStore extends Appearance {
  /** Incremented on every user edit (not on hydrate), so only real edits are saved. */
  editVersion: number
  /** This browser keeps its own appearance and doesn't sync it with the server. */
  deviceOnly: boolean
  /** User edit: apply, cache, and mark for saving to the server. */
  set: (patch: Partial<Appearance>) => void
  /** Load values from the server without triggering a save. */
  hydrate: (a: StoredAppearance) => void
  setDeviceOnly: (on: boolean) => void
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
  deviceOnly: loadDeviceOnly(),
  set: (patch) => {
    set({ ...patch, editVersion: get().editVersion + 1 })
    persist(currentAppearance())
  },
  hydrate: (a) => {
    const full = withDefaults(a)
    set(full)
    persist(full)
  },
  setDeviceOnly: (on) => {
    try {
      if (on) localStorage.setItem(DEVICE_ONLY_KEY, '1')
      else localStorage.removeItem(DEVICE_ONLY_KEY)
    } catch {
      // ignore
    }
    set({ deviceOnly: on })
  },
}))

/** Re-apply when the OS theme changes and the user chose "system". */
export function watchSystemTheme(): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const onChange = () => {
    const a = currentAppearance()
    if (a.mode === 'system') applyAppearance(a)
  }
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}
