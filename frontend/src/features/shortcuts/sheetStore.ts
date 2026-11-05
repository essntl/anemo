import { create } from 'zustand'
import { useMediaQuery } from '@/hooks/useMediaQuery'

/** Whether the shortcut sheet (press ?) is open. A store, so Settings and the search box can open it. */
export const useShortcutSheet = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))

/** A mouse or trackpad is there, so most likely a keyboard too. Touch-only devices get no sheet. */
const KEYBOARD = '(any-pointer: fine)'

export function useHasKeyboard(): boolean {
  return useMediaQuery(KEYBOARD)
}

export function hasKeyboard(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(KEYBOARD).matches
}
