/**
 * Focus sessions waiting to be sent to the server. A session is put here first and
 * sent right away; if the browser is offline (or the server can't be reached) it
 * stays, saved on this device, and is sent later: when the browser is back online,
 * when the app opens, and every minute while something waits. The server stores a
 * session once per `client_id`, so sending one twice is harmless.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { api, ApiError, unwrap } from '@/api/client'
import type { SessionRecord } from './timer'

interface Outbox {
  pending: SessionRecord[]
}

export const useOutbox = create<Outbox>()(persist(() => ({ pending: [] as SessionRecord[] }), { name: 'anemo-focus-outbox' }))

let sending: Promise<number> | null = null
const sentListeners = new Set<() => void>()

/** Called after sessions were stored on the server (to refresh lists). */
export function onSessionsSent(fn: () => void): () => void {
  sentListeners.add(fn)
  return () => sentListeners.delete(fn)
}

export function enqueueSession(session: SessionRecord): void {
  useOutbox.setState((s) => ({ pending: [...s.pending.filter((p) => p.clientId !== session.clientId), session] }))
  void flushOutbox()
}

async function send(session: SessionRecord): Promise<void> {
  unwrap(
    await api.POST('/api/focus/sessions', {
      body: {
        client_id: session.clientId,
        phase: session.phase,
        started_at: new Date(session.startedAt).toISOString(),
        ended_at: new Date(session.endedAt).toISOString(),
        minutes: session.minutes,
        completed: session.completed,
        task_id: session.taskId,
      },
    }),
  )
}

/** Send what is waiting, oldest first. Resolves to how many were stored. */
export function flushOutbox(): Promise<number> {
  if (sending) return sending
  sending = (async () => {
    let sent = 0
    for (const session of [...useOutbox.getState().pending]) {
      try {
        await send(session)
      } catch (err) {
        // Refused for good (e.g. invalid): drop it. Offline, or a server error: try later.
        const permanent = err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 408 && err.status !== 429
        if (!permanent) break
      }
      sent += 1
      useOutbox.setState((s) => ({ pending: s.pending.filter((p) => p.clientId !== session.clientId) }))
    }
    if (sent) sentListeners.forEach((fn) => fn())
    return sent
  })().finally(() => {
    sending = null
  })
  return sending
}
