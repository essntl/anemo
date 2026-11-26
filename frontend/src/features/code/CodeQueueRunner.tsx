/**
 * Moves what an older version of the Code page queued in this browser (queueStore.ts
 * `byThread`) to the server, where messages for a running job are kept now
 * (docs/specs/code-sessions.md §15): the server hands each one to its job, or sends it as
 * the next follow-up, with or without a browser open. Mounted once for the whole app; it
 * does something only while such a message is left. One that the server refuses goes back
 * into its thread's box (the draft), so nothing is lost.
 */
import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@/components/ui/toast'
import { t } from '@/lib/i18n'
import { sendMessage } from './api'
import { codeQueue, useCodeQueue } from './queueStore'

/** One mover per thread at a time in this tab; the lock keeps other tabs out. */
const moving = new Set<string>()

async function locked(name: string, run: () => Promise<void>): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.locks) await navigator.locks.request(name, run)
  else await run()
}

export function CodeQueueRunner() {
  const qc = useQueryClient()
  const queue = useCodeQueue((s) => s.byThread)
  useEffect(() => {
    for (const threadId of Object.keys(queue)) {
      if (moving.has(threadId)) continue
      moving.add(threadId)
      void locked(`anemo.codeQueue.${threadId}`, async () => {
        const message = await codeQueue.take(threadId)
        if (!message) return
        try {
          await sendMessage(qc, message.jobId, message.text, message.images ?? [])
        } catch {
          const draft = useCodeQueue.getState().drafts[threadId]
          codeQueue.setDraft(threadId, draft ? `${message.text}\n\n${draft}` : message.text)
          if (message.images?.length) codeQueue.setDraftImages(threadId, (now) => [...(message.images ?? []), ...now])
          toast({ message: t('A queued message couldn’t be sent: it is back in its thread’s box.') })
        }
      }).finally(() => moving.delete(threadId))
    }
  }, [qc, queue])
  return null
}
