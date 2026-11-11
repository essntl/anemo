import { useState, type ReactNode } from 'react'
import * as RadixDialog from '@radix-ui/react-dialog'
import { NavLink, useLocation } from 'react-router'
import { House, Inbox, LayoutGrid, MessagesSquare, Plus, Settings } from 'lucide-react'
import { cn } from '@/lib/cn'
import { InboxBadge } from './badges'
import { MORE, PINNED } from './pageList'

const TAB = 'relative flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium'

function Tab({ to, label, icon, badge, end }: { to: string; label: string; icon: ReactNode; badge?: ReactNode; end?: boolean }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => cn(TAB, isActive ? 'text-accent' : 'text-muted')}>
      <span className="relative [&>svg]:h-[22px] [&>svg]:w-[22px]">
        {icon}
        {badge && <span className="absolute -right-3 -top-1.5 scale-[0.8] empty:hidden">{badge}</span>}
      </span>
      {label}
    </NavLink>
  )
}

/** The pages a tab does not lead to, as a sheet from the bottom edge: one tap each. */
function MoreSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const tabs = new Set(['/home', '/notifications'])
  const pages = [...PINNED, ...MORE].filter((p) => !tabs.has(p.to))
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fade fixed inset-0 z-40 bg-black/35" />
        <RadixDialog.Content aria-describedby={undefined}
          className="sheet fixed inset-x-0 bottom-0 z-50 rounded-t-panel border border-border bg-card px-3 pt-2 shadow-float focus:outline-none pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div aria-hidden className="mx-auto mb-2 h-1 w-9 rounded-full bg-border-strong" />
          <RadixDialog.Title className="px-2 pb-2 text-[17px] font-bold tracking-tight">More</RadixDialog.Title>
          <nav aria-label="More pages" className="grid grid-cols-4 gap-1">
            {[...pages, { to: '/settings', icon: <Settings />, label: 'Settings' }].map((p) => (
              <NavLink key={p.to} to={p.to} title={'title' in p ? p.title : undefined} onClick={() => onOpenChange(false)}
                className={({ isActive }) =>
                  cn('relative flex h-[4.75rem] min-w-0 flex-col items-center justify-center gap-1.5 rounded-control px-1 text-[12.5px] font-medium [&>svg]:h-6 [&>svg]:w-6',
                    isActive ? 'bg-surface-2 text-text [&>svg]:text-accent' : 'text-text [&>svg]:text-muted')}>
                {p.icon}
                <span className="w-full truncate text-center">{p.label}</span>
                {'badge' in p && p.badge && <span className="absolute right-3 top-1.5 scale-90 empty:hidden">{p.badge}</span>}
              </NavLink>
            ))}
          </nav>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

/**
 * Phones: the bar along the bottom edge, where thumbs reach. Home, the chats, a new chat
 * in the middle, the Inbox with its count, and More for every other page. With it on
 * screen the top bar needs no menu button (a swipe from the left still opens the menu
 * with the chat list). Hidden from `md` up, and on a conversation, where the message box
 * has the bottom edge.
 */
export function MobileTabBar() {
  const [more, setMore] = useState(false)
  const { pathname } = useLocation()
  const inMore = [...PINNED, ...MORE].some((p) => !['/home', '/notifications'].includes(p.to) && (pathname === p.to || pathname.startsWith(`${p.to}/`)))
    || pathname.startsWith('/settings')
  return (
    <>
      <nav aria-label="Main" className="flex h-14 shrink-0 items-stretch border-t border-border bg-surface px-1 md:hidden">
        <Tab to="/home" label="Home" icon={<House />} />
        <Tab to="/chats" label="Chats" icon={<MessagesSquare />} />
        <NavLink to="/" end aria-label="New chat" className="flex flex-1 items-center justify-center">
          <span className="flex h-10 w-12 items-center justify-center rounded-control bg-accent text-accent-contrast shadow-soft"><Plus className="h-5 w-5" /></span>
        </NavLink>
        <Tab to="/notifications" label="Inbox" icon={<Inbox />} badge={<InboxBadge />} />
        <button type="button" aria-haspopup="dialog" aria-expanded={more} onClick={() => setMore(true)}
          className={cn(TAB, inMore ? 'text-accent' : 'text-muted')}>
          <span className="[&>svg]:h-[22px] [&>svg]:w-[22px]"><LayoutGrid /></span>
          More
        </button>
      </nav>
      <MoreSheet open={more} onOpenChange={setMore} />
    </>
  )
}
