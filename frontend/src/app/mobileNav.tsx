/**
 * Phone navigation: below the `md` breakpoint (768px) the sidebar lives in a
 * slide-in drawer, opened from a menu button in the page's top bar.
 */
import { Link } from 'react-router'
import { Menu, SquarePen } from 'lucide-react'
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

/** The default phone top bar. Hidden from `md` up, where the sidebar is always visible. */
export function MobileTopBar() {
  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-1.5 md:hidden">
      <MenuButton />
      <span className="flex-1 text-center text-[15px] font-semibold">anemo</span>
      <NewChatButton />
    </header>
  )
}
