/**
 * Sending a queued message (queueStore.ts) as a follow-up, and why one is held instead.
 */
import type { QueryClient } from '@tanstack/react-query'
import { toast } from '@/components/ui/toast'
import { t } from '@/lib/i18n'
import { sendFollowUp, startErrorMessage } from './api'
import { type QueuedMessage, codeQueue } from './queueStore'
import type { CodeJob } from './threads'

/** Why a follow-up can't be sent after `job` by itself; null when it can. */
export function holdReason(job: CodeJob): string | null {
  if (job.state === 'failed' || job.state === 'exited_without_result') return t('The job didn’t finish, so this message wasn’t sent.')
  if (!job.session_id) return t('The job left no session to continue, so this message wasn’t sent.')
  if (!job.device.online) return t('{device} went offline, so this message wasn’t sent.', { device: job.device.name })
  if (!job.device.start) return t('{device} no longer lets Anemo start jobs, so this message wasn’t sent.', { device: job.device.name })
  return null
}

/** A thread's title in a notice: short, and never empty. */
const named = (title: string | null | undefined) => {
  const text = title?.trim() || t('(no title)')
  return text.length > 60 ? `${text.slice(0, 59)}…` : text
}

/**
 * Keeps a message that wasn't sent, and says so with the thread's `title`: the user may
 * be on another page, with other jobs running.
 */
export function holdQueued(threadId: string, message: QueuedMessage, reason: string, title?: string | null): void {
  codeQueue.hold(threadId, message, reason)
  toast({ message: t('“{title}”: {reason}', { title: named(title), reason }) })
}

/** One sender per thread at a time in this tab; the lock keeps other tabs out. */
const sending = new Set<string>()

async function locked(name: string, run: () => Promise<void>): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.locks) await navigator.locks.request(name, run)
  else await run()
}

/** Sends the thread's queued message as a follow-up of `job` (the thread's last job, ended). `title`: the thread's. */
export async function sendQueued(qc: QueryClient, threadId: string, job: CodeJob, title?: string | null): Promise<void> {
  if (sending.has(threadId)) return
  sending.add(threadId)
  try {
    await locked(`anemo.codeQueue.${threadId}`, async () => {
      const message = await codeQueue.take(threadId)
      if (!message) return
      try {
        await sendFollowUp(qc, job.id, message.text)
        toast({ message: t('Queued message sent: “{title}”', { title: named(title) }) })
      } catch (err) {
        holdQueued(threadId, message, startErrorMessage(err), title)
      }
    })
  } finally {
    sending.delete(threadId)
  }
}
