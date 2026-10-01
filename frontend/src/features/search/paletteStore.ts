import { create } from 'zustand'

/** Whether the search box (Ctrl+K) is open. A store, so the sidebar button can open it too. */
export const usePalette = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))
