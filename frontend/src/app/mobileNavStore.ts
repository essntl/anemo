import { create } from 'zustand'

/** Whether the phone menu (the sidebar drawer) is open, and the pages card in it. */
interface MobileNavState {
  open: boolean
  setOpen: (open: boolean) => void
  /** The card with every page (PagesFolder). Closing the menu closes it too. */
  pagesOpen: boolean
  setPagesOpen: (open: boolean) => void
}

export const useMobileNav = create<MobileNavState>((set) => ({
  open: false,
  setOpen: (open) => set(open ? { open } : { open, pagesOpen: false }),
  pagesOpen: false,
  setPagesOpen: (pagesOpen) => set({ pagesOpen }),
}))

/** Route `handle` for pages that render their own phone top bar (see AppLayout). */
export interface RouteHandle {
  ownMobileHeader?: boolean
}
