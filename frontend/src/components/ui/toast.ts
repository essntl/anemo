/**
 * Short notices at the bottom of the screen, optionally with one action:
 *
 *   toast({ message: 'Saved to memory: Likes tea.', action: { label: 'Undo', onClick: remove } })
 *
 * <ToastHost /> (ToastHost.tsx, mounted once in AppLayout) shows them; each
 * disappears by itself after a few seconds.
 */
import { create } from 'zustand'

export interface ToastOptions {
  message: string
  action?: { label: string; onClick: () => void }
  /** Milliseconds until it disappears (default 6000). */
  duration?: number
}

interface ToastItem extends ToastOptions {
  id: number
}

interface ToastStore {
  toasts: ToastItem[]
  dismiss: (id: number) => void
}

let nextId = 1

export const useToasts = create<ToastStore>((set) => ({
  toasts: [],
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

export function toast(options: ToastOptions): void {
  const id = nextId++
  // Keep at most three on screen: older ones make room.
  useToasts.setState((s) => ({ toasts: [...s.toasts.slice(-2), { ...options, id }] }))
  window.setTimeout(() => useToasts.getState().dismiss(id), options.duration ?? 6000)
}
