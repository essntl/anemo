/**
 * The theme a plugin frame gets (contract §6.3 "Theme"): light or dark, the density, and
 * the values of Anemo's design tokens, read from the page as they are right now (so the
 * user's accent, tint, fonts and Compact density all come along).
 *
 * The names on the left are the plugin-facing ones and part of the contract; the ones on
 * the right are Anemo's own tokens (styles/tokens.css, app.css), which may be renamed
 * without breaking a plugin: only this table changes then.
 */
export interface FrameTheme {
  mode: 'light' | 'dark'
  density: 'comfortable' | 'compact'
  vars: Record<string, string>
  /** The user asked for less motion (the system's prefers-reduced-motion). */
  reducedMotion: boolean
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION).matches
}

const VARS: [plugin: string, anemo: string][] = [
  ['--accent', '--accent'],
  ['--accent-hover', '--accent-hover'],
  ['--accent-soft', '--accent-soft'],
  ['--accent-contrast', '--accent-contrast'],
  ['--bg', '--bg'],
  ['--surface', '--surface'],
  ['--surface-2', '--surface-2'],
  ['--surface-hover', '--surface-hover'],
  ['--card', '--card'],
  ['--text', '--text'],
  ['--muted', '--text-muted'],
  ['--subtle', '--text-subtle'],
  ['--border', '--border'],
  ['--border-strong', '--border-strong'],
  ['--success', '--success'],
  ['--warning', '--warning'],
  ['--error', '--error'],
  ['--info', '--info'],
  ['--radius-control', '--radius-control'],
  ['--radius-card', '--radius-card'],
  ['--font-ui', '--font-sans'],
  ['--font-code', '--font-mono'],
  ['--shadow-soft', '--shadow-soft'],
  ['--card-x', '--card-x'],
  ['--card-y', '--card-y'],
  ['--row-y', '--row-y'],
  ['--card-gap', '--card-gap'],
  ['--stack-gap', '--stack-gap'],
  ['--item-x', '--item-x'],
  ['--item-y', '--item-y'],
  ['--btn-h', '--btn-h'],
  ['--btn-sm-h', '--btn-sm-h'],
]

/** The theme as the page shows it now. */
export function currentTheme(root: HTMLElement = document.documentElement): FrameTheme {
  const style = getComputedStyle(root)
  const vars: Record<string, string> = {}
  for (const [name, token] of VARS) {
    const value = style.getPropertyValue(token).trim()
    if (value) vars[name] = value
  }
  return {
    mode: root.dataset.theme === 'dark' ? 'dark' : 'light',
    density: root.dataset.density === 'compact' ? 'compact' : 'comfortable',
    vars,
    reducedMotion: prefersReducedMotion(),
  }
}

/**
 * Calls `onChange` with the new theme whenever the appearance changes (Settings >
 * Appearance writes its variables and data attributes on <html>, see appearance/apply.ts)
 * and when the system's reduced-motion setting changes.
 * Only real changes are reported. Returns a function that stops watching.
 */
export function watchTheme(onChange: (theme: FrameTheme) => void, root: HTMLElement = document.documentElement): () => void {
  let last = JSON.stringify(currentTheme(root))
  let frame = 0
  const check = () => {
    frame = 0
    const theme = currentTheme(root)
    const text = JSON.stringify(theme)
    if (text === last) return
    last = text
    onChange(theme)
  }
  // Several attributes change in one go: look once, on the next frame.
  const observer = new MutationObserver(() => {
    if (!frame) frame = requestAnimationFrame(check)
  })
  observer.observe(root, { attributes: true, attributeFilter: ['style', 'class', 'data-theme', 'data-density'] })
  // The system's motion setting can change while Anemo is open.
  const motion = typeof window.matchMedia === 'function' ? window.matchMedia(REDUCED_MOTION) : null
  const onMotion = () => {
    if (!frame) frame = requestAnimationFrame(check)
  }
  motion?.addEventListener?.('change', onMotion)
  return () => {
    observer.disconnect()
    motion?.removeEventListener?.('change', onMotion)
    if (frame) cancelAnimationFrame(frame)
  }
}
