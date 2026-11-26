/**
 * What the assistant of the chat on screen is doing right now: thinking (a run is going
 * but no answer text is arriving), streaming (answer text arrived a moment ago) or idle.
 * Only the state, never the text. The chat page reports it (`useReportAssistantActivity`);
 * anything else may read it, e.g. the plugin host's `assistant.activity` event.
 */
import { useEffect } from 'react'

export type AssistantActivity = 'thinking' | 'streaming' | 'idle'

/** Without new text for this long, a running answer counts as thinking again. */
export const STREAMING_QUIET_MS = 1200

let current: AssistantActivity = 'idle'
const listeners = new Set<(state: AssistantActivity) => void>()

export function assistantActivity(): AssistantActivity {
  return current
}

export function setAssistantActivity(state: AssistantActivity): void {
  if (state === current) return
  current = state
  listeners.forEach((fn) => fn(state))
}

/** Calls `fn` with every change. Returns a function that stops listening. */
export function watchAssistantActivity(fn: (state: AssistantActivity) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/**
 * Reports the shown chat's activity: `running` while a run is going, `textLength` the
 * length of the answer so far (it growing means streaming). Idle again when unmounted.
 */
export function useReportAssistantActivity(running: boolean, textLength: number): void {
  useEffect(() => {
    if (!running) {
      setAssistantActivity('idle')
      return
    }
    // A change of the text length while running: streaming, then thinking after a pause.
    setAssistantActivity(textLength > 0 ? 'streaming' : 'thinking')
    const timer = window.setTimeout(() => setAssistantActivity('thinking'), STREAMING_QUIET_MS)
    return () => window.clearTimeout(timer)
  }, [running, textLength])
  useEffect(() => () => setAssistantActivity('idle'), [])
}
