import { useEffect } from 'react'
import * as RadixDialog from '@radix-ui/react-dialog'
import { Outlet, useLocation, useMatches } from 'react-router'
import { DialogHost } from '@/components/ui/DialogHost'
import { ToastHost } from '@/components/ui/ToastHost'
import { ReauthDialog } from '@/features/auth/ReauthDialog'
import { MoveChatsDialog } from '@/features/chat/components/MoveChatsDialog'
import { useAppEvents } from '@/features/chat/useAppEvents'
import { CommandPalette } from '@/features/search/CommandPalette'
import { useAppearanceSync } from '@/features/settings/useAppearanceSync'
import { MobileTopBar } from './mobileNav'
import { type RouteHandle, useMobileNav } from './mobileNavStore'
import { Sidebar } from './Sidebar'
import { useSidebarSwipe } from './useSidebarSwipe'

/** On phones the sidebar slides in from the left (menu button, or swipe right); the
 *  scrim, Esc, navigating or a swipe left closes it. See useSidebarSwipe. */
function SidebarDrawer() {
  const { open, setOpen } = useMobileNav()
  return (
    <RadixDialog.Root open={open} onOpenChange={setOpen}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fade fixed inset-0 z-40 bg-black/40 md:hidden" />
        <RadixDialog.Content
          aria-describedby={undefined}
          className="drawer fixed inset-y-0 left-0 z-50 flex w-[min(85vw,20rem)] shadow-float focus:outline-none md:hidden"
        >
          <RadixDialog.Title className="sr-only">Menu</RadixDialog.Title>
          <Sidebar className="w-full pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))]" onClose={() => setOpen(false)} />
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

export function AppLayout() {
  useAppearanceSync()
  useAppEvents()
  useSidebarSwipe()
  const location = useLocation()
  const setOpen = useMobileNav((s) => s.setOpen)
  // Close the phone menu whenever the page changes (e.g. after tapping a link in it).
  useEffect(() => setOpen(false), [location.pathname, location.search, setOpen])
  // Pages like a conversation put the menu button into their own header instead.
  const ownHeader = useMatches().some((m) => (m.handle as RouteHandle | undefined)?.ownMobileHeader)

  return (
    <div className="flex h-full">
      <Sidebar className="hidden w-64 md:flex" />
      <SidebarDrawer />
      <div className="flex min-w-0 flex-1 flex-col">
        {!ownHeader && <MobileTopBar />}
        <main className="page min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
      <ReauthDialog />
      <DialogHost />
      <MoveChatsDialog />
      <ToastHost />
      <CommandPalette />
    </div>
  )
}
