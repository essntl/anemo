import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * How the sidebar is shown, remembered on this device: on a desktop it can be folded
 * to a narrow strip of icons, which leaves more room for the page (Ctrl+\ switches).
 */
interface SidebarState {
  collapsed: boolean
  setCollapsed: (collapsed: boolean) => void
}

export const useSidebar = create<SidebarState>()(
  persist(
    (set) => ({
      collapsed: false,
      setCollapsed: (collapsed) => set({ collapsed }),
    }),
    { name: 'anemo-sidebar' },
  ),
)
