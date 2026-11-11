import type { ReactNode } from 'react'
import { NavLink, useLocation } from 'react-router'
import * as RadixDialog from '@radix-ui/react-dialog'
import { motion } from 'motion/react'
import { LayoutGrid, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { useMobileNav } from './mobileNavStore'

export interface PageEntry {
  to: string
  icon: ReactNode
  label: string
  /** The full name, when `label` is a short one. */
  title?: string
  /** A count or dot for the page (renders nothing when there is nothing to show). */
  badge?: ReactNode
}

/** The shape both the bar and the card take, so one can morph into the other. */
const SHAPE = 'pages-folder'
const MORPH = { type: 'spring', stiffness: 520, damping: 42, mass: 0.9 } as const

/** Which of the pages the address is on, if any. */
function currentPage(pages: PageEntry[], pathname: string): PageEntry | undefined {
  return pages.find((p) => pathname === p.to || pathname.startsWith(`${p.to}/`))
}

/**
 * The phone menu's pages, folded into one bar so the chats get the room. Tapping the
 * bar grows it into a card in the middle of the screen with every page on it, like a
 * folder on a phone's home screen; a tap outside it, ✕ or Esc folds it back, and the
 * menu around it stays open.
 */
export function PagesFolder({ pages, onNavigate }: { pages: PageEntry[]; onNavigate?: () => void }) {
  const open = useMobileNav((s) => s.pagesOpen)
  const setOpen = useMobileNav((s) => s.setPagesOpen)
  const { pathname } = useLocation()
  const here = currentPage(pages, pathname)

  return (
    <>
      {open ? (
        // Keeps the bar's place while it is open, so the chats above don't jump.
        <div aria-hidden className="h-12 shrink-0" />
      ) : (
        <motion.button type="button" layoutId={SHAPE} transition={MORPH} onClick={() => setOpen(true)}
          aria-haspopup="dialog" aria-label={here ? t('Pages, on {page}', { page: here.title ?? here.label }) : t('Pages')}
          style={{ borderRadius: 14 }}
          className="flex h-12 w-full shrink-0 items-center gap-3 border border-border bg-surface-2 px-3.5 text-left">
          <motion.span layout="position" className={cn('flex min-w-0 flex-1 items-center gap-2.5 text-[15px] font-medium', here ? 'text-accent' : 'text-text')}>
            <span className="shrink-0 [&>svg]:h-5 [&>svg]:w-5">{here?.icon ?? <LayoutGrid />}</span>
            <span className="truncate">{here?.label ?? t('Pages')}</span>
          </motion.span>
          {/* A count on a page is never folded away: it shows on the bar too. */}
          {/* layout="position": while the card shrinks back into the bar, these keep their shape. */}
          <motion.span layout="position" className="flex shrink-0 items-center gap-1.5">
            {pages.map((p) => p.badge && <span key={p.to} className="flex scale-90 empty:hidden">{p.badge}</span>)}
          </motion.span>
          <motion.span layout="position" aria-hidden className="grid shrink-0 grid-cols-2 gap-0.5 rounded-md bg-surface-hover p-1 text-muted [&_svg]:h-2.5 [&_svg]:w-2.5">
            {pages.filter((p) => p !== here).slice(0, 4).map((p) => <span key={p.to}>{p.icon}</span>)}
          </motion.span>
        </motion.button>
      )}

      {/* A dialog inside the menu's dialog: Esc and a tap outside fold only the card.
          Radix alone decides when the card is there (no exit animation to wait for, so
          an interrupted one can't leave an invisible card blocking the screen); motion
          only morphs: the bar or the card that appears grows from where the other was. */}
      <RadixDialog.Root open={open} onOpenChange={setOpen}>
        <RadixDialog.Portal>
          {/* Tapping the dimmed screen folds the card at once (Radix's own outside-tap check
              only starts a moment after opening, and a quick tap could slip past it). */}
          <RadixDialog.Overlay className="fade fixed inset-0 z-50 bg-black/45 backdrop-blur-[3px]" onClick={() => setOpen(false)} />
          <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-4">
            <RadixDialog.Content asChild aria-describedby={undefined}>
              <motion.div layoutId={SHAPE} transition={MORPH} style={{ borderRadius: 24 }}
                className="pointer-events-auto relative w-[min(100%,21rem)] overflow-hidden border border-border bg-card p-3 shadow-float focus:outline-none">
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { delay: 0.1, duration: 0.16 } }}>
                  <div className="mb-2 flex items-center justify-between pl-2">
                    <RadixDialog.Title className="text-[15px] font-semibold">{t('Pages')}</RadixDialog.Title>
                    <RadixDialog.Close aria-label={t('Close pages')}
                      className="flex h-10 w-10 items-center justify-center rounded-control text-muted hover:bg-surface-hover hover:text-text">
                      <X className="h-5 w-5" />
                    </RadixDialog.Close>
                  </div>
                  <nav aria-label={t('Pages')} className="grid grid-cols-3 gap-1">
                    {pages.map((p) => (
                      <NavLink key={p.to} to={p.to} title={p.title}
                        onClick={() => { setOpen(false); onNavigate?.() }}
                        className={({ isActive }) =>
                          cn('relative flex h-[4.5rem] min-w-0 flex-col items-center justify-center gap-1.5 rounded-card px-1 text-[13px] font-medium transition-colors',
                            isActive ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-hover hover:text-text')}>
                        <span className="[&>svg]:h-6 [&>svg]:w-6">{p.icon}</span>
                        <span className="w-full truncate text-center">{p.label}</span>
                        {p.badge && <span className="absolute right-2 top-1.5 scale-90">{p.badge}</span>}
                      </NavLink>
                    ))}
                  </nav>
                </motion.div>
              </motion.div>
            </RadixDialog.Content>
          </div>
        </RadixDialog.Portal>
      </RadixDialog.Root>
    </>
  )
}
