import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { CodeImage } from './codeImages'

/**
 * What is typed in a thread's box and not sent yet, remembered in this browser and shared by
 * its tabs. Messages for a running job are kept on the server (docs/specs/code-sessions.md
 * §15); `byThread` holds only what an older version of the page queued here, which
 * `CodeQueueRunner` moves to the server once.
 */
export interface QueuedMessage {
  /** A job of the thread (the one that ran when the message was written). */
  jobId: string
  text: string
  images?: CodeImage[]
  held?: string
}

interface QueueState {
  /** Messages an older version of the page queued in this browser (moved to the server). */
  byThread: Record<string, QueuedMessage>
  /** What is typed in a thread's box and not sent or queued yet: it survives leaving the thread. */
  drafts: Record<string, string>
  /** The images added to a thread's box and not sent or queued yet (like `drafts`). */
  draftImages?: Record<string, CodeImage[]>
}

const NAME = 'anemo.codeQueue'

export const useCodeQueue = create<QueueState>()(persist(() => ({ byThread: {} as Record<string, QueuedMessage>, drafts: {} as Record<string, string> }), { name: NAME }))

// Another tab changed a draft (or moved the old queue).
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === NAME) void useCodeQueue.persist.rehydrate()
  })
}

const without = <T,>(all: Record<string, T>, threadId: string) => {
  const { [threadId]: _gone, ...rest } = all
  return rest
}

export const codeQueue = {
  setDraft(threadId: string, text: string) {
    useCodeQueue.setState((s) => ({ drafts: text ? { ...s.drafts, [threadId]: text } : without(s.drafts, threadId) }))
  },
  setDraftImages(threadId: string, update: (images: CodeImage[]) => CodeImage[]) {
    useCodeQueue.setState((s) => {
      const all = s.draftImages ?? {}
      const next = update(all[threadId] ?? [])
      return { draftImages: next.length ? { ...all, [threadId]: next } : without(all, threadId) }
    })
  },
  /** Take a message of the old queue, as storage has it now (another tab may have moved it). */
  async take(threadId: string): Promise<QueuedMessage | null> {
    await useCodeQueue.persist.rehydrate()
    const message = useCodeQueue.getState().byThread[threadId] ?? null
    if (message) useCodeQueue.setState((s) => ({ byThread: without(s.byThread, threadId) }))
    return message
  },
}
