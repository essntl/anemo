import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * The tasks lined up for the next focus sessions, in order (Focus page, "Up next").
 * When the task being worked on is marked done, the first one here takes its place.
 * Remembered on this device.
 */
interface QueueState {
  ids: string[]
}

export const useFocusQueue = create<QueueState>()(persist(() => ({ ids: [] as string[] }), { name: 'anemo.focusQueue' }))

export const focusQueue = {
  /** Add a task at the end (once). */
  add(id: string) {
    useFocusQueue.setState((s) => (s.ids.includes(id) ? s : { ids: [...s.ids, id] }))
  },
  remove(id: string) {
    useFocusQueue.setState((s) => ({ ids: s.ids.filter((x) => x !== id) }))
  },
  /** Take the first task that is still in `open` off the queue; null when there is none. */
  next(open: ReadonlySet<string>): string | null {
    const { ids } = useFocusQueue.getState()
    const id = ids.find((x) => open.has(x)) ?? null
    // Tasks that were finished or deleted elsewhere drop out on the way.
    useFocusQueue.setState({ ids: ids.filter((x) => open.has(x) && x !== id) })
    return id
  },
}
