import { create } from 'zustand'

const MAX_CHARS = 64_000 // keep the tail; the full (capped) output is in the timeline once done

/**
 * Live output of running shell commands, keyed by tool call id. Filled from the
 * run's `tool.progress` events (see ConversationPage); the finished output comes
 * from the timeline API instead.
 */
interface ShellOutputState {
  output: Record<string, string>
  append: (callId: string, text: string) => void
}

export const useShellOutput = create<ShellOutputState>((set) => ({
  output: {},
  append: (callId, text) =>
    set((s) => {
      const next = (s.output[callId] ?? '') + text
      return { output: { ...s.output, [callId]: next.length > MAX_CHARS ? next.slice(-MAX_CHARS) : next } }
    }),
}))
