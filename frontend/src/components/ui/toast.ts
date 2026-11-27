/**
 * Short notices at the bottom of the screen, optionally with one action:
 *
 *   toast({ message: 'Saved to memory: Likes tea.', action: { label: 'Undo', onClick: remove } })
 *
 * A richer one (an in-app notification): a title, a line or two of text, a level that
 * colours its edge and icon, and an icon of its own:
 *
 *   toast({ title: 'Job finished', message: 'All tests pass.', level: 'success', icon: <Bot />,
 *           action: { label: 'View job', onClick: open } })
 *
 * <ToastHost /> (ToastHost.tsx, mounted once in AppLayout) shows them, the newest three
 * at a time, and closes each after its time; the time waits while the pointer is over
 * them, focus is in them, or the tab is hidden.
 */
import type { ReactNode } from 'react'
import { create } from 'zustand'
import { EXIT_LIMIT_MS } from './closing'

export type ToastLevel = 'info' | 'success' | 'warning' | 'error'

export interface ToastOptions {
  message: string
  /** Shown first, in bold; `message` is then the line or two under it. */
  title?: string
  /** Colours the notice's edge and icon; warnings and errors are announced at once
   *  (role="alert"). Without it, a plain notice. */
  level?: ToastLevel
  /** An icon of its own (what the notice is about); else the level's icon. */
  icon?: ReactNode
  action?: { label: string; onClick: () => void }
  /** Milliseconds until it disappears (default 6000), not counting time it waited. */
  duration?: number
}

export interface ToastItem extends ToastOptions {
  id: number
  /** Set while it animates out, just before it is removed. */
  leaving?: boolean
}

interface ToastStore {
  toasts: ToastItem[]
  /** Starts the closing animation; ToastHost calls `remove` when it has ended. */
  dismiss: (id: number) => void
  remove: (id: number) => void
  dismissAll: () => void
}

/** Shown at once; the older ones fold into "+N more". */
export const VISIBLE_TOASTS = 3
/** Kept at most (the oldest go first). */
const KEPT = 20

let nextId = 1

export const useToasts = create<ToastStore>((set, get) => ({
  toasts: [],
  dismiss: (id) => {
    set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)) }))
    // In case no animation runs (reduced motion, a hidden tab).
    window.setTimeout(() => useToasts.getState().remove(id), EXIT_LIMIT_MS)
  },
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  dismissAll: () => {
    for (const t of get().toasts) get().dismiss(t.id)
  },
}))

export function toast(options: ToastOptions): void {
  const id = nextId++
  useToasts.setState((s) => ({ toasts: [...s.toasts.slice(-(KEPT - 1)), { ...options, id }] }))
}
