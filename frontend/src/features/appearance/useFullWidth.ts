import { DESKTOP, useMediaQuery } from '@/hooks/useMediaQuery'
import { useThemeStore } from '@/features/settings/theme'
import { isFullWidth, type WidthPage } from './fullWidthPages'

/** Whether this page uses the full width here (never on a phone). */
export function useFullWidth(page: WidthPage): boolean {
  const desktop = useMediaQuery(DESKTOP)
  const setting = useThemeStore((s) => s.full_width)
  const pages = useThemeStore((s) => s.full_width_pages)
  return desktop && isFullWidth(page, setting, pages)
}
