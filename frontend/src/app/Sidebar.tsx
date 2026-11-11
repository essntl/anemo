import { useState, type ReactNode } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { NavLink, useLocation, useNavigate } from 'react-router'
import {
  ChevronRight,
  Inbox,
  LayoutGrid,
  LogOut,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Logo } from '@/components/ui/Logo'
import { useLogout, useMe } from '@/features/auth/api'
import { ConversationList } from '@/features/chat/components/ConversationList'
import { usePalette } from '@/features/search/paletteStore'
import { shortcutText } from '@/features/shortcuts/registry'
import { ShortcutKeys } from '@/features/shortcuts/ShortcutKeys'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { InboxBadge } from './badges'
import { usePages } from './pageList'
import { PagesFolder, type PageEntry } from './PagesFolder'
import { ScopeControl } from './ScopeControl'
import { useSidebar } from './sidebarStore'

// 32px rows: with six pages, More and the chats the sidebar still fits a 720px-high window without scrolling.
const ROW = 'flex h-8 min-w-0 items-center gap-2.5 rounded-control px-2.5 text-[13px] font-medium transition-colors pointer-coarse:h-10'
const ROW_ON = 'bg-surface-2 font-semibold text-text [&>span>svg]:text-accent'
const ROW_OFF = 'text-text hover:bg-surface-hover [&>span>svg]:text-muted'
const ICON_BUTTON = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface-hover hover:text-text'

/** One page in the sidebar's list: an icon, its name, and a count at the end of the row. */
function PageLink({ to, icon, children, title, badge }: { to: string; icon: ReactNode; children: ReactNode; title?: string; badge?: ReactNode }) {
  return (
    <NavLink to={to} title={title} className={({ isActive }) => cn(ROW, isActive ? ROW_ON : ROW_OFF)}>
      <span className="shrink-0 [&>svg]:h-[17px] [&>svg]:w-[17px]">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {badge}
    </NavLink>
  )
}

/** A round icon button in the phone menu's header. */
function HeaderLink({ to, label, icon, badge, onClick }: { to: string; label: string; icon: ReactNode; badge?: ReactNode; onClick?: () => void }) {
  return (
    <NavLink to={to} aria-label={label} title={label} onClick={onClick}
      className={({ isActive }) =>
        cn('relative flex h-10 w-10 items-center justify-center rounded-control [&>svg]:h-5 [&>svg]:w-5',
          isActive ? 'bg-surface-2 text-accent' : 'text-muted hover:bg-surface-hover hover:text-text')}>
      {icon}
      {badge && <span className="absolute -right-0.5 -top-0.5 scale-75">{badge}</span>}
    </NavLink>
  )
}

/** A thin line that sets the parts of the sidebar apart. */
function Divider({ className }: { className?: string }) {
  return <div aria-hidden className={cn('h-px shrink-0 bg-border', className)} />
}

/** Whether the address is on this page (or on something inside it). */
const isOn = (page: PageEntry, pathname: string) => pathname === page.to || pathname.startsWith(`${page.to}/`)

/**
 * The pages that are not pinned, behind one row: it opens a card beside the sidebar
 * with all of them. Their counts show on the row too, so nothing waits unseen.
 */
function MorePages({ pages }: { pages: PageEntry[] }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" aria-label={t('More pages')} className={cn(ROW, 'w-full text-left', open ? 'bg-surface-hover text-text [&>span>svg]:text-muted' : ROW_OFF)}>
          <span className="shrink-0 [&>svg]:h-[17px] [&>svg]:w-[17px]"><LayoutGrid /></span>
          {/* The arrow sits by the name, so the counts end at the same edge as the Inbox's. */}
          <span className="flex min-w-0 flex-1 items-center gap-1">
            <span className="truncate">{t('More')}</span>
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-subtle" />
          </span>
          {pages.map((p) => p.badge && <span key={p.to} className="flex empty:hidden">{p.badge}</span>)}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="right" align="start" sideOffset={14} collisionPadding={12}
          className="pop z-50 w-72 rounded-card border border-border bg-card p-2 shadow-float">
          <nav aria-label={t('More pages')} className="grid grid-cols-3 gap-1">
            {pages.map((p) => (
              <NavLink key={p.to} to={p.to} title={p.title} onClick={() => setOpen(false)}
                className={({ isActive }) =>
                  cn('relative flex h-[4.25rem] min-w-0 flex-col items-center justify-center gap-1.5 rounded-control px-1 text-[12.5px] font-medium transition-colors [&>svg]:h-5 [&>svg]:w-5',
                    isActive ? 'bg-surface-2 text-text [&>svg]:text-accent' : 'text-text hover:bg-surface-hover [&>svg]:text-muted')}>
                {p.icon}
                <span className="w-full truncate text-center">{p.label}</span>
                {p.badge && <span className="absolute right-2 top-1.5 scale-90">{p.badge}</span>}
              </NavLink>
            ))}
          </nav>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

/** One page in the folded sidebar: an icon, with its name as a tooltip. */
function RailLink({ to, label, icon, badge }: { to: string; label: string; icon: ReactNode; badge?: ReactNode }) {
  return (
    <NavLink to={to} title={label} aria-label={label}
      className={({ isActive }) =>
        cn('relative flex h-9 w-9 shrink-0 items-center justify-center rounded-control transition-colors [&>svg]:h-[17px] [&>svg]:w-[17px]',
          isActive ? 'bg-surface-2 text-accent' : 'text-muted hover:bg-surface-hover hover:text-text')}>
      {icon}
      {badge && <span className="absolute -right-1 -top-1 scale-75">{badge}</span>}
    </NavLink>
  )
}

/** The sidebar folded to a strip of icons (desktop only). */
export function SidebarRail({ className }: { className?: string }) {
  const navigate = useNavigate()
  const openSearch = usePalette((s) => s.setOpen)
  const setCollapsed = useSidebar((s) => s.setCollapsed)
  const { pinned, more } = usePages()
  const button = 'flex h-9 w-9 shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface-hover hover:text-text'
  return (
    <nav aria-label={t('Menu')} className={cn('h-full w-14 shrink-0 flex-col items-center gap-1 overflow-y-auto bg-surface py-3', className)}>
      <button type="button" aria-label={t('Show the sidebar')} title={t('Show the sidebar ({keys})', { keys: shortcutText('app.sidebar') })} onClick={() => setCollapsed(false)} className={button}>
        <PanelLeftOpen className="h-4 w-4" />
      </button>
      <Button variant="primary" size="icon" className="mt-2 shrink-0" aria-label={t('New chat')} title={t('New chat')} onClick={() => navigate('/')}>
        <Plus className="h-4 w-4" />
      </Button>
      <button type="button" aria-label={t('Search everything')} title={t('Search everything ({keys})', { keys: shortcutText('app.search') })} onClick={() => openSearch(true)} className={button}>
        <Search className="h-4 w-4" />
      </button>
      <RailLink to="/chats" label={t('All chats')} icon={<MessagesSquare />} />
      <Divider className="my-2 w-8" />
      {[...pinned, ...more].map((p) => <RailLink key={p.to} to={p.to} label={p.title ?? p.label} icon={p.icon} badge={p.badge} />)}
      <Divider className="mb-2 mt-auto w-8" />
      <RailLink to="/settings" label={t('Settings')} icon={<Settings />} />
    </nav>
  )
}

/** `onClose` is set when the sidebar is shown in the phone drawer. */
export function Sidebar({ className, onClose }: { className?: string; onClose?: () => void }) {
  const navigate = useNavigate()
  const me = useMe()
  const logout = useLogout()
  const openSearch = usePalette((s) => s.setOpen)
  const setCollapsed = useSidebar((s) => s.setCollapsed)
  const { pathname } = useLocation()
  // A page from "More" that you are on joins the list while you are there.
  const { pinned, more } = usePages()
  const here = more.find((p) => isOn(p, pathname))
  return (
    // Normally nothing here scrolls but the chats; in a very low window the sidebar as a
    // whole does, rather than squeezing the chats away.
    <aside className={cn('h-full shrink-0 flex-col overflow-y-auto bg-surface p-3', onClose ? 'flex' : '', className)}>
      <div className={cn('flex items-center gap-2 px-1.5', onClose ? 'mb-3 gap-1' : 'mb-3')}>
        {/* The logo leads home. */}
        <NavLink to="/home" title={t('Home')} aria-label={t('Anemo, go to Home')}
          className="-m-1 flex min-w-0 flex-1 items-center gap-2 rounded-control p-1">
          <Logo className="h-7 w-7 shrink-0 text-accent pointer-coarse:h-9 pointer-coarse:w-9" />
          <span className="ml-0.5 text-[18px] font-bold tracking-tight pointer-coarse:text-[22px]">Anemo</span>
        </NavLink>
        {onClose ? (
          // On a phone the Inbox and Settings sit up here, so the chats get the room.
          <>
            <HeaderLink to="/notifications" label={t('Inbox')} icon={<Inbox />} badge={<InboxBadge />} />
            <HeaderLink to="/settings" label={t('Settings')} icon={<Settings />} />
            <button type="button" aria-label={t('Close menu')} onClick={onClose}
              className="flex h-10 w-10 items-center justify-center rounded-control text-muted hover:bg-surface-hover hover:text-text">
              <X className="h-5 w-5" />
            </button>
          </>
        ) : (
          <button type="button" aria-label={t('Hide the sidebar')} title={t('Hide the sidebar ({keys})', { keys: shortcutText('app.sidebar') })} onClick={() => setCollapsed(true)}
            className={ICON_BUTTON}>
            <PanelLeftClose className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* What is shown: Uncategorized, a project, or All. */}
      <ScopeControl onNavigate={onClose} />

      <Button variant="primary" className="mt-2.5 w-full shrink-0 justify-center" icon={<Plus className="h-4 w-4" />} onClick={() => navigate('/')}>
        {t('New chat')}
      </Button>
      {/* Search everything (also Ctrl+K): chats by title and text, documents, files, tasks, … */}
      <button type="button" aria-label={t('Search everything')} title={t('Search everything ({keys})', { keys: shortcutText('app.search') })}
        // On a phone the search takes the screen, so the menu makes way for it.
        onClick={() => { onClose?.(); openSearch(true) }}
        className="mt-2 flex h-10 w-full shrink-0 items-center gap-2 rounded-control border border-border-strong bg-surface px-3 text-left text-[13px] text-subtle hover:border-muted pointer-coarse:h-11 pointer-coarse:text-[15px]">
        <Search className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{t('Search or jump to…')}</span>
        <ShortcutKeys id="app.search" className="pointer-coarse:hidden" />
      </button>

      {/* The pages (desktop): the pinned ones, then the rest behind "More". */}
      {!onClose && (
        <nav aria-label={t('Pages')} className="mt-2.5 flex shrink-0 flex-col gap-0.5">
          {pinned.map((p) => <PageLink key={p.to} to={p.to} icon={p.icon} title={p.title} badge={p.badge}>{p.label}</PageLink>)}
          {here && <PageLink to={here.to} icon={here.icon} title={here.title} badge={here.badge}>{here.label}</PageLink>}
          {more.length > 0 && <MorePages pages={more} />}
        </nav>
      )}

      {/* The chats take all the free height and are the only thing that scrolls. */}
      {!onClose && <Divider className="-mx-3 mt-2.5" />}
      <div className="flex min-h-36 flex-1 flex-col">
        <ConversationList />
        <NavLink to="/chats"
          className={({ isActive }) => cn(ROW, 'mt-1 shrink-0 pointer-coarse:h-11 pointer-coarse:text-[15px]', isActive ? ROW_ON : ROW_OFF)}>
          <span className="shrink-0 [&>svg]:h-[17px] [&>svg]:w-[17px]"><MessagesSquare /></span>
          <span className="flex-1">{t('All chats')}</span>
          <ChevronRight className="h-3.5 w-3.5 text-subtle" />
        </NavLink>
      </div>

      {onClose ? (
        // On a phone the pages fold into one bar that opens as a card (PagesFolder).
        <>
          <Divider className="-mx-3 my-2" />
          {/* The Inbox is an icon in this menu's header, so the card doesn't repeat it. */}
          <PagesFolder pages={[...pinned, ...more].filter((p) => p.to !== '/notifications')} onNavigate={onClose} />
        </>
      ) : (
        // Who is signed in, with Settings and Sign out (under Settings > General too).
        <>
          <Divider className="-mx-3 mt-2" />
          <div className="-mb-1 flex shrink-0 items-center gap-1 pt-2">
            <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[12px] font-semibold uppercase text-accent">
              {me.data?.username.slice(0, 1) ?? ''}
            </span>
            <span className="ml-1 min-w-0 flex-1 truncate text-[13px] font-medium">{me.data?.username}</span>
            <NavLink to="/settings" aria-label={t('Settings')} title={t('Settings')}
              className={({ isActive }) => cn(ICON_BUTTON, isActive && 'bg-surface-2 text-accent')}>
              <Settings className="h-4 w-4" />
            </NavLink>
            <button type="button" aria-label={t('Sign out')} onClick={() => logout.mutate()} title={me.data ? t('Sign out (signed in as {name})', { name: me.data.username }) : t('Sign out')}
              className={ICON_BUTTON}>
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </>
      )}
    </aside>
  )
}
