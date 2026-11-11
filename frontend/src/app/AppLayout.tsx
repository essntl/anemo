import { useEffect } from 'react'
import * as RadixDialog from '@radix-ui/react-dialog'
import { Outlet, useLocation, useMatches } from 'react-router'
import { DialogHost } from '@/components/ui/DialogHost'
import { ToastHost } from '@/components/ui/ToastHost'
import { ReauthDialog } from '@/features/auth/ReauthDialog'
import { MoveChatsDialog } from '@/features/chat/components/MoveChatsDialog'
import { useAppEvents } from '@/features/chat/useAppEvents'
import { useServiceWorkerLinks } from '@/features/notifications/useServiceWorkerLinks'
import { Island } from '@/features/island/Island'
import { CommandPalette } from '@/features/search/CommandPalette'
import { useAppearanceSync } from '@/features/settings/useAppearanceSync'
import { ShareDialog } from '@/features/shares/ShareDialog'
import { ShortcutSheet } from '@/features/shortcuts/ShortcutSheet'
import { useHasKeyboard, useShortcutSheet } from '@/features/shortcuts/sheetStore'
import { useShortcut } from '@/hooks/useShortcut'
import { TopBar } from './mobileNav'
import { MobileTabBar } from './MobileTabBar'
import { PersistentLayer } from './PersistentLayer'
import { type RouteHandle, useMobileNav } from './mobileNavStore'
import { Sidebar, SidebarRail } from './Sidebar'
import { useSidebar } from './sidebarStore'
import { useSidebarSwipe } from './useSidebarSwipe'

/** On phones the sidebar slides in from the left (menu button, or swipe right); the
 *  scrim, Esc, navigating or a swipe left closes it. See useSidebarSwipe. */
function SidebarDrawer() {
  const { open, setOpen } = useMobileNav()
  const foldPagesFirst = (e: Event) => {
    const { pagesOpen, setPagesOpen } = useMobileNav.getState()
    if (!pagesOpen) return
    e.preventDefault()
    setPagesOpen(false)
  }
  return (
    <RadixDialog.Root open={open} onOpenChange={setOpen}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fade fixed inset-0 z-40 bg-black/40 md:hidden" />
        <RadixDialog.Content
          aria-describedby={undefined}
          // While the pages card is open, Esc and a tap outside fold the card, not the menu
          // (right after the card opens, Radix may still hand them to the menu).
          onEscapeKeyDown={foldPagesFirst}
          onPointerDownOutside={foldPagesFirst}
          className="drawer fixed inset-y-0 left-0 z-50 flex w-[min(85vw,20rem)] shadow-float focus:outline-none md:hidden"
        >
          <RadixDialog.Title className="sr-only">Menu</RadixDialog.Title>
          <Sidebar className="w-full pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))]" onClose={() => setOpen(false)} />
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

/** The pages that show only what the switcher allows. */
const SCOPED = ['/', '/home', '/tasks', '/calendar', '/documents', '/files', '/stats']

export function AppLayout() {
  useAppearanceSync()
  useAppEvents()
  useServiceWorkerLinks()
  useSidebarSwipe()
  const location = useLocation()
  // Desktop: the sidebar can be folded to a strip of icons (its button, or Ctrl+\).
  const collapsed = useSidebar((s) => s.collapsed)
  useShortcut('app.sidebar', () => {
    const { collapsed: now, setCollapsed } = useSidebar.getState()
    setCollapsed(!now)
  })
  // ? shows every shortcut (not on touch-only devices, which have no keyboard to use).
  const keyboard = useHasKeyboard()
  useShortcut('app.shortcuts', () => useShortcutSheet.getState().setOpen(true), keyboard)
  const setOpen = useMobileNav((s) => s.setOpen)
  // Close the phone menu whenever the page changes (e.g. after tapping a link in it).
  useEffect(() => setOpen(false), [location.pathname, location.search, setOpen])
  // Pages like a conversation put the menu button into their own header instead.
  const handles = useMatches().map((m) => m.handle as RouteHandle | undefined)
  const ownHeader = handles.some((h) => h?.ownMobileHeader)
  const ownPhoneHeader = handles.some((h) => h?.ownPhoneHeader)
  const scoped = SCOPED.some((p) => (p === '/' ? location.pathname === '/' : location.pathname === p || location.pathname.startsWith(`${p}/`)))

  return (
    <div className="flex h-full">
      {/* Desktop: the sidebar is a white panel on the ground, like the cards of a page. */}
      <div className="hidden shrink-0 p-3 pr-0 md:flex">
        {collapsed
          ? <SidebarRail className="flex rounded-panel shadow-soft" />
          : <Sidebar className="flex w-[17rem] rounded-panel shadow-soft" />}
      </div>
      <SidebarDrawer />
      {/* The page column. The Dynamic Island floats at the top centre of it (not of the
          window), over the page header; see features/island/Island.tsx. */}
      <div id="main-column" className="relative flex min-w-0 flex-1 flex-col">
        {/* Phones: what is shown (Uncategorized, a project, All) is a line under the title on the pages it changes. */}
        {!ownHeader && <TopBar scoped={scoped} phoneHidden={ownPhoneHeader} />}
        <Island />
        {/* relative: anything absolutely placed inside a page is held (and clipped) here,
            so it can never make the whole window scroll. */}
        <main className="page relative min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
        {/* Phones: the tabs along the bottom (a conversation keeps that edge for its message box). */}
        {!ownHeader && <MobileTabBar />}
      </div>
      <PersistentLayer />
      <ReauthDialog />
      <DialogHost />
      <MoveChatsDialog />
      <ShareDialog />
      <ToastHost />
      <CommandPalette />
      <ShortcutSheet />
    </div>
  )
}
