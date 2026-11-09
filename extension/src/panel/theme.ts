/**
 * Light or dark follows the system (prefers-color-scheme); the accent colour is Anemo's
 * (Settings → Appearance), cached with the connection.
 */
const HEX = /^#[0-9a-f]{6}$/i

export function applyTheme(dark: boolean): void {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}

export function applyAccent(accent: string | null | undefined): void {
  if (accent && HEX.test(accent)) document.documentElement.style.setProperty('--accent', accent)
  else document.documentElement.style.removeProperty('--accent')
}

export function followSystemTheme(): () => void {
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  const update = () => applyTheme(query.matches)
  update()
  query.addEventListener('change', update)
  return () => query.removeEventListener('change', update)
}
