/**
 * Applying a plugin's theme (contract §2.2 `themes`): a preset of Settings > Appearance.
 * Never applied by the plugin itself, only when the user presses "Apply"; it goes through
 * the same theme store as the Appearance page, so it shows at once and is saved (and can be
 * changed back there).
 */
import { currentAppearance, useThemeStore, type Appearance } from '@/features/settings/theme'
import type { ManifestTheme } from './types'

/** The appearance after applying `theme` to `current` (only the fields the theme sets change). */
export function appearanceWith(current: Appearance, theme: ManifestTheme['appearance']): Partial<Appearance> {
  const patch: Partial<Appearance> = {}
  if (theme.mode) patch.mode = theme.mode
  if (theme.accent) patch.accent = theme.accent.toLowerCase()
  if (theme.tint !== undefined) patch.tint = theme.tint ? theme.tint.toLowerCase() : null
  if (theme.tintStrength !== undefined) patch.tint_strength = theme.tintStrength
  if (theme.uiFont) patch.ui_font = theme.uiFont
  if (theme.codeFont) patch.code_font = theme.codeFont
  if (theme.glass !== undefined) patch.glass = theme.glass
  if (theme.glassStrength !== undefined) patch.glass_strength = theme.glassStrength
  // Uploads aren't part of a plugin theme: only "none" or the animated gradient.
  if (theme.background) patch.background = { ...current.background, kind: theme.background }
  return patch
}

export function applyPluginTheme(theme: ManifestTheme): void {
  useThemeStore.getState().set(appearanceWith(currentAppearance(), theme.appearance))
}
