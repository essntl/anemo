/**
 * The keyboard shortcut sheet: press ? anywhere outside a text field (or Ctrl+K →
 * "Keyboard shortcuts", or Settings → General). Lists every entry of registry.ts,
 * grouped by area, with the page you are on first.
 */
import { useLocation } from 'react-router'
import { Dialog } from '@/components/ui/Dialog'
import { Lingering } from '@/components/ui/Lingering'
import { t } from '@/lib/i18n'
import { type Shortcut, sheetSections, SHORTCUTS } from './registry'
import { ShortcutKeys } from './ShortcutKeys'
import { useShortcutSheet } from './sheetStore'

export function ShortcutSheet() {
  const { open, setOpen } = useShortcutSheet()
  return (
    <Lingering value={open}>
      {() => <SheetDialog onClose={() => setOpen(false)} />}
    </Lingering>
  )
}

function SheetDialog({ onClose }: { onClose: () => void }) {
  const { pathname } = useLocation()
  const sections = sheetSections(pathname)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t('Keyboard shortcuts')}
      description={t('Single keys work when you are not typing in a field.')}
      className="md:w-[min(92vw,720px)]">
      <div className="grid gap-x-8 gap-y-5 md:grid-cols-2" data-testid="shortcut-sheet">
        {sections.map(({ area, shortcuts }) => (
          <section key={area.id} aria-labelledby={`shortcuts-${area.id}`} data-area={area.id}>
            <h3 id={`shortcuts-${area.id}`} className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-subtle">{t(area.title)}</h3>
            <ul className="flex flex-col divide-y divide-border">
              {shortcuts.map(({ id }) => {
                const s: Shortcut = SHORTCUTS[id]
                return (
                  <li key={id} className="flex items-center justify-between gap-3 py-1.5 text-[13px]">
                    <span className="min-w-0">{t(s.description)}</span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {s.prefix && <span className="text-[11.5px] text-muted">{t(s.prefix)}</span>}
                      <ShortcutKeys id={id} />
                    </span>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  )
}
