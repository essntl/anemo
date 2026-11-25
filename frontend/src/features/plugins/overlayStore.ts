import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Plugin overlays (slot "overlay"): whether the user has hidden all of them, remembered on
 * this device (Ctrl+K "Hide plugin overlays" / "Show plugin overlays"). It lives in Anemo's
 * own storage: no plugin can read or change it. `count` is how many overlays the enabled
 * plugins have (set by PluginOverlays), so the command is only offered when there are some.
 */
interface OverlayState {
  hidden: boolean
  count: number
  setHidden: (hidden: boolean) => void
  setCount: (count: number) => void
}

export const usePluginOverlays = create<OverlayState>()(
  persist(
    (set) => ({
      hidden: false,
      count: 0,
      setHidden: (hidden) => set({ hidden }),
      setCount: (count) => set({ count }),
    }),
    { name: 'anemo.pluginOverlays', partialize: (s) => ({ hidden: s.hidden }) },
  ),
)
