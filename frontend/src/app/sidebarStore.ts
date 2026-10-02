import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * How the sidebar is shown, remembered on this device.
 *
 * `menuOpen`: whether the menu under the chat list (Files, Tasks, Runs, …) is open.
 * Closed, the sidebar is just your chats, with more room for them. The first time it
 * starts closed on phones and open on larger screens.
 *
 * `collapsed`: on a desktop, the sidebar is folded to a narrow strip of icons, which
 * leaves more room for the page (Ctrl+\ switches).
 */
interface SidebarState {
  menuOpen: boolean
  setMenuOpen: (open: boolean) => void
  collapsed: boolean
  setCollapsed: (collapsed: boolean) => void
}

const startsOpen = () => typeof window === 'undefined' || !window.matchMedia('(max-width: 767px)').matches

export const useSidebar = create<SidebarState>()(
  persist(
    (set) => ({
      menuOpen: startsOpen(),
      setMenuOpen: (menuOpen) => set({ menuOpen }),
      collapsed: false,
      setCollapsed: (collapsed) => set({ collapsed }),
    }),
    { name: 'anemo-sidebar' },
  ),
)
