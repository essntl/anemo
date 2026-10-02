/**
 * Short notices at the bottom of the screen, optionally with one action:
 *
 *   toast({ message: 'Saved to memory: Likes tea.', action: { label: 'Undo', onClick: remove } })
 *
 * <ToastHost /> (ToastHost.tsx, mounted once in AppLayout) shows them; each
 * disappears by itself after a few seconds.
 */
import { create } from 'zustand'
import { EXIT_LIMIT_MS } from './closing'

export interface ToastOptions {
  message: string
  action?: { label: string; onClick: () => void }
  /** Milliseconds until it disappears (default 6000). */
  duration?: number
}

interface ToastItem extends ToastOptions {
  id: number
  /** Set while it animates out, just before it is removed. */
  leaving?: boolean
}

interface ToastStore {
  toasts: ToastItem[]
  /** Starts the closing animation; ToastHost calls `remove` when it has ended. */
  dismiss: (id: number) => void
  remove: (id: number) => void
}

let nextId = 1

export const useToasts = create<ToastStore>((set) => ({
  toasts: [],
  dismiss: (id) => {
    set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)) }))
    // In case no animation runs (reduced motion, a hidden tab).
    window.setTimeout(() => useToasts.getState().remove(id), EXIT_LIMIT_MS)
  },
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

export function toast(options: ToastOptions): void {
  const id = nextId++
  // Keep at most three on screen: older ones make room.
  useToasts.setState((s) => ({ toasts: [...s.toasts.slice(-2), { ...options, id }] }))
  window.setTimeout(() => useToasts.getState().dismiss(id), options.duration ?? 6000)
}
