import { create } from 'zustand'

/**
 * "Stop after": the music pauses by itself once this much time has passed (Music page).
 * `minutes` is what was chosen, `until` the moment it ends. Not kept across reloads:
 * a reload stops the music anyway.
 */
interface SleepState {
  minutes: number | null
  until: number | null
}

export const SLEEP_CHOICES = [15, 30, 45, 60, 90]

export const useSleepTimer = create<SleepState>(() => ({ minutes: null, until: null }))

/** Stop the music after this many minutes; `null` lets it play on. */
export function stopAfter(minutes: number | null, now = Date.now()): void {
  useSleepTimer.setState(minutes === null ? { minutes: null, until: null } : { minutes, until: now + minutes * 60_000 })
}
