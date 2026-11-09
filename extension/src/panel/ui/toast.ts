/** Short messages at the bottom of the panel ("Archived · Undo"). One at a time. */
import { useSyncExternalStore } from 'react'

export interface Toast {
  id: number
  message: string
  action?: { label: string; run: () => void }
  tone?: 'info' | 'error'
}

let current: Toast | null = null
let timer: number | undefined
let seq = 0
const listeners = new Set<() => void>()

function emit(): void {
  listeners.forEach((fn) => fn())
}

export function toast(message: string, opts: { action?: Toast['action']; tone?: Toast['tone']; ms?: number } = {}): void {
  window.clearTimeout(timer)
  current = { id: ++seq, message, action: opts.action, tone: opts.tone }
  timer = window.setTimeout(dismissToast, opts.ms ?? (opts.action ? 7000 : 3500))
  emit()
}

export function dismissToast(): void {
  window.clearTimeout(timer)
  current = null
  emit()
}

export function useToast(): Toast | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => current,
  )
}
