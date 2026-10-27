/**
 * Short messages the Dynamic Island grows to show for a moment: a timer phase that
 * finished, tracks added to the queue, an agent run that finished or needs approval.
 * Everything else keeps using toast() (components/ui/toast.ts).
 *
 *   islandAlert({ title: 'Break time', body: '5 minutes off', icon: 'coffee', tone: 'success' })
 *
 * One alert is shown at a time; others wait their turn. Alerts with the same `key`
 * replace each other instead of queueing (pressing shuffle three times shows its
 * latest state once). They are never stored.
 */
import { create } from 'zustand'

export type AlertTone = 'accent' | 'success' | 'info' | 'warning' | 'error'
export type AlertIcon = 'timer' | 'coffee' | 'music' | 'plus' | 'skip' | 'bot' | 'approval' | 'warning' | 'check' | 'shuffle' | 'repeat'

export interface IslandAlert {
  id: number
  title: string
  body?: string
  icon?: AlertIcon
  /** A picture (album artwork) shown instead of the icon when it loads. */
  image?: string | null
  tone: AlertTone
  /** Ms on screen. */
  duration: number
  key?: string
  /** Clicking the alert opens this page (e.g. the chat that waits for an approval). */
  link?: string
}

export type AlertInput = Omit<IslandAlert, 'id' | 'tone' | 'duration'> & Partial<Pick<IslandAlert, 'tone' | 'duration'>>

interface AlertState {
  current: IslandAlert | null
  queue: IslandAlert[]
}

export const useIslandAlerts = create<AlertState>(() => ({ current: null, queue: [] }))

let nextId = 1
let timer: ReturnType<typeof setTimeout> | null = null

function showNext() {
  if (timer) clearTimeout(timer)
  timer = null
  const [current = null, ...queue] = useIslandAlerts.getState().queue
  useIslandAlerts.setState({ current, queue })
  if (current) timer = setTimeout(showNext, current.duration)
}

export function islandAlert(input: AlertInput): void {
  const alert: IslandAlert = { tone: 'accent', duration: 3200, ...input, id: nextId++ }
  const { current, queue } = useIslandAlerts.getState()
  if (alert.key) {
    const rest = queue.filter((a) => a.key !== alert.key)
    if (current?.key === alert.key) {
      useIslandAlerts.setState({ queue: [alert, ...rest] })
      showNext()
      return
    }
    useIslandAlerts.setState({ queue: rest })
  }
  useIslandAlerts.setState((s) => ({ queue: [...s.queue, alert] }))
  if (!current && !timer) showNext()
}

/** Close the alert on screen now (clicked, or Esc). */
export function dismissIslandAlert(): void {
  showNext()
}
