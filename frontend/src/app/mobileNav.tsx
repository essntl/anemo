/**
 * The top bar of a page, and the phone navigation: below the `md` breakpoint (768px) the
 * sidebar lives in a slide-in drawer, opened from a menu button in the top bar.
 */
import { Link } from 'react-router'
import { Menu, SquarePen } from 'lucide-react'
import { topBarEnd, topBarStart } from '@/components/ui/topBarSlots'
import { cn } from '@/lib/cn'
import { useMobileNav } from './mobileNavStore'

const iconButton =
  'flex h-10 w-10 shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface-hover hover:text-text'

export function MenuButton({ className }: { className?: string }) {
  const setOpen = useMobileNav((s) => s.setOpen)
  return (
    <button type="button" aria-label="Open menu" onClick={() => setOpen(true)} className={cn(iconButton, 'md:hidden', className)}>
      <Menu className="h-5 w-5" />
    </button>
  )
}

export function NewChatButton({ className }: { className?: string }) {
  return (
    <Link to="/" aria-label="New chat" className={cn(iconButton, 'md:hidden', className)}>
      <SquarePen className="h-5 w-5" />
    </Link>
  )
}

/**
 * The bar at the top of every page (a conversation has its own): the page's title on the
 * left and its buttons on the right (a page fills both with <PageHeader>), with the
 * middle kept free for the Dynamic Island, which floats over it. On a phone the menu
 * button sits at its start (New chat is in the tab bar along the bottom).
 */
export function TopBar() {
  // Each half stops short of the Island while it shows (.island-clear-left in app.css).
  const half = 'island-clear-left flex min-w-0 flex-1 [--island-gap:3.25rem] md:[--island-gap:1.75rem]'
  return (
    <header className="flex h-12 shrink-0 items-center gap-1 px-1.5 md:h-14 md:gap-3 md:px-8">
      <MenuButton />
      <div ref={topBarStart} className={cn(half, 'items-center gap-2.5 max-md:pl-1')} />
      <div ref={topBarEnd} className={cn(half, 'ml-auto items-center justify-end gap-1.5 max-md:pr-1')} />
    </header>
  )
}
