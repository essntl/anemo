/**
 * The top bar of a page, and the phone navigation: below the `md` breakpoint (768px) the
 * sidebar lives in a slide-in drawer. Where the tabs along the bottom show, they lead
 * everywhere and a swipe from the left opens the drawer; a conversation, which has no
 * tabs, has a menu button in its own header.
 */
import { Link } from 'react-router'
import { Menu, SquarePen } from 'lucide-react'
import { topBarEnd, topBarStart } from '@/components/ui/topBarSlots'
import { cn } from '@/lib/cn'
import { useMobileNav } from './mobileNavStore'
import { ScopeControl } from './ScopeControl'
import { t } from '@/lib/i18n'

const iconButton =
  'flex h-10 w-10 shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface-hover hover:text-text'

export function MenuButton({ className }: { className?: string }) {
  const setOpen = useMobileNav((s) => s.setOpen)
  return (
    <button type="button" aria-label={t('Open menu')} onClick={() => setOpen(true)} className={cn(iconButton, 'md:hidden', className)}>
      <Menu className="h-5 w-5" />
    </button>
  )
}

export function NewChatButton({ className }: { className?: string }) {
  return (
    <Link to="/" aria-label={t('New chat')} className={cn(iconButton, 'md:hidden', className)}>
      <SquarePen className="h-5 w-5" />
    </Link>
  )
}

/**
 * The bar at the top of every page (a conversation has its own): the page's title on the
 * left and its buttons on the right (a page fills both with <PageHeader>), with the
 * middle kept free for the Dynamic Island, which floats over it (on a phone it moves to
 * the right end when the page has no buttons there). A phone has no menu button here:
 * the tab bar along the bottom is on every page that has this bar.
 *
 * `scoped`: the page shows only what the project switcher allows. On a phone the switcher
 * is then a small line under the title (on wider screens it is in the sidebar).
 * `phoneHidden`: the page has a header of its own on a phone (an open document).
 */
export function TopBar({ scoped, phoneHidden }: { scoped?: boolean; phoneHidden?: boolean }) {
  // Each half stops short of the Island while it shows (.island-clear-left in app.css).
  const half = 'island-clear-left flex min-w-0 flex-1 [--island-gap:0.5rem] md:[--island-gap:1.75rem]'
  return (
    // overflow-x-clip: a page's buttons can never make the window scroll sideways.
    <header className={cn('flex h-12 shrink-0 items-center gap-1 overflow-x-clip px-1.5 md:h-14 md:gap-3 md:px-8', phoneHidden && 'max-md:hidden')}>
      <div className={cn(half, 'flex-col justify-center max-md:pl-2.5',
        // Two lines in the bar's height: the title is set a little smaller above the switcher.
        scoped && 'max-md:[&_h1]:text-[17px] max-md:[&_h1]:leading-[22px]')}>
        <div ref={topBarStart} className="flex min-w-0 items-center gap-2.5" />
        {scoped && <div className="flex min-w-0 md:hidden"><ScopeControl variant="inline" /></div>}
      </div>
      {/* On a phone the buttons take the room they need, at their full width (the Island
          makes way for them, not they for it), and the title gets the rest. */}
      <div ref={topBarEnd} className={cn(half, 'ml-auto items-center justify-end gap-1.5 max-md:flex-none max-md:whitespace-nowrap max-md:pr-1 max-md:*:shrink-0')} />
    </header>
  )
}
