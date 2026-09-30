import { create } from 'zustand'

/** Whether the phone menu (the sidebar drawer) is open. */
interface MobileNavState {
  open: boolean
  setOpen: (open: boolean) => void
}

export const useMobileNav = create<MobileNavState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))

/** Route `handle` for pages that render their own phone top bar (see AppLayout). */
export interface RouteHandle {
  ownMobileHeader?: boolean
}
