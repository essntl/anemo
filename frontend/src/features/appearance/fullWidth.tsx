/**
 * Full width (Settings > Appearance): content uses the whole window instead of the
 * centred column. The setting is the default for every page that has it; a page's own
 * button (FullWidthToggle, in its header) switches just that page and is remembered in
 * `full_width_pages`. Phones always keep their layout: they are narrow anyway.
 */
import { ChevronsLeftRight, ChevronsRightLeft } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { DESKTOP, useMediaQuery } from '@/hooks/useMediaQuery'
import { t } from '@/lib/i18n'
import { useThemeStore } from '@/features/settings/theme'
import { isFullWidth, type WidthPage, withPageChoice } from './fullWidthPages'

export type { WidthPage } from './fullWidthPages'

/** The page header's button that switches this page between the column and the full width. */
export function FullWidthToggle({ page }: { page: WidthPage }) {
  const desktop = useMediaQuery(DESKTOP)
  const setting = useThemeStore((s) => s.full_width)
  const pages = useThemeStore((s) => s.full_width_pages)
  const set = useThemeStore((s) => s.set)
  if (!desktop) return null
  const on = isFullWidth(page, setting, pages)
  return (
    <Button size="icon" variant={on ? 'secondary' : 'ghost'} aria-pressed={on} aria-label={t('Full width')}
      title={on ? t('Back to the centred column') : t('Use the full width of the window')}
      onClick={() => set({ full_width_pages: withPageChoice(pages, page, !on, setting) })}>
      {on ? <ChevronsRightLeft className="h-4 w-4" /> : <ChevronsLeftRight className="h-4 w-4" />}
    </Button>
  )
}
