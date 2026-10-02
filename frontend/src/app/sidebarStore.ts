import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Whether the menu under the chat list (Files, Tasks, Runs, …) is open. Closed, the
 * sidebar is just your chats, with more room for them. Remembered on this device; the
 * first time it starts closed on phones and open on larger screens.
 */
interface SidebarState {
  menuOpen: boolean
  setMenuOpen: (open: boolean) => void
}

const startsOpen = () => typeof window === 'undefined' || !window.matchMedia('(max-width: 767px)').matches

export const useSidebar = create<SidebarState>()(
  persist(
    (set) => ({
      menuOpen: startsOpen(),
      setMenuOpen: (menuOpen) => set({ menuOpen }),
    }),
    { name: 'anemo-sidebar' },
  ),
)
