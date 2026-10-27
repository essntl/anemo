import { useSyncExternalStore } from 'react'

/*
 * The current time, updated once a minute, shared by every component that asks. For
 * displays that depend on the day or the hour (greetings, "today" lists), so they
 * move on at midnight without a reload.
 */
let now = Date.now()
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (!timer) {
    now = Date.now()
    timer = setInterval(() => {
      now = Date.now()
      listeners.forEach((l) => l())
    }, 60_000)
  }
  return () => {
    listeners.delete(listener)
    if (!listeners.size && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

/** Epoch ms, at most a minute old. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now)
}

/** The start of the current local day, as epoch ms (changes once a day). */
export function useToday(): number {
  const n = useNow()
  const d = new Date(n)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}
