import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { CodeImage } from './codeImages'

/**
 * Messages written while a Claude Code job runs, one per thread, waiting for that job
 * to end. A job takes its prompt when it starts and nothing after (`claude -p`), so a
 * message for a running job can only be the next follow-up: `CodeQueueRunner` sends it
 * when the job has ended. Remembered in this browser, and shared by its tabs.
 */
export interface QueuedMessage {
  /** A job of the thread (the one that ran when the message was written). */
  jobId: string
  text: string
  /** Uploaded images that go with it (their ids: the images stay on the server until it is sent). */
  images?: CodeImage[]
  /** Why it wasn't sent by itself (the job failed, the computer went offline, …): it waits for the user. */
  held?: string
}

interface QueueState {
  byThread: Record<string, QueuedMessage>
  /** What is typed in a thread's box and not sent or queued yet: it survives leaving the thread. */
  drafts: Record<string, string>
  /** The images added to a thread's box and not sent or queued yet (like `drafts`). */
  draftImages?: Record<string, CodeImage[]>
}

const NAME = 'anemo.codeQueue'

export const useCodeQueue = create<QueueState>()(persist(() => ({ byThread: {} as Record<string, QueuedMessage>, drafts: {} as Record<string, string> }), { name: NAME }))

// Another tab queued, sent or removed a message.
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
  /** Queue a message for the thread; one already waiting gets it as a new paragraph (and its images after its own). */
  add(threadId: string, jobId: string, text: string, images: CodeImage[] = []) {
    useCodeQueue.setState((s) => {
      const before = s.byThread[threadId]
      const all = [...(before?.images ?? []), ...images]
      const message: QueuedMessage = { jobId, text: before ? `${before.text}\n\n${text}` : text, ...(all.length ? { images: all } : {}) }
      return { byThread: { ...s.byThread, [threadId]: message } }
    })
  },
  remove(threadId: string) {
    useCodeQueue.setState((s) => (threadId in s.byThread ? { byThread: without(s.byThread, threadId) } : s))
  },
  /** Put a message back as it was (undoing a removal). */
  put(threadId: string, message: QueuedMessage) {
    useCodeQueue.setState((s) => ({ byThread: { ...s.byThread, [threadId]: message } }))
  },
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
  /** Take the thread's message off the queue, as storage has it now (another tab may have sent it). */
  async take(threadId: string): Promise<QueuedMessage | null> {
    await useCodeQueue.persist.rehydrate()
    const message = useCodeQueue.getState().byThread[threadId] ?? null
    if (message) codeQueue.remove(threadId)
    return message
  },
  /** Keep a message that wasn't sent, with the reason: the user sends, edits or discards it. */
  hold(threadId: string, message: QueuedMessage, reason: string) {
    useCodeQueue.setState((s) => ({ byThread: { ...s.byThread, [threadId]: { ...message, held: reason } } }))
  },
}
