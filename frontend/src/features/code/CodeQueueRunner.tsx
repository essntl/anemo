/**
 * Sends the queued messages (queueStore.ts): mounted once for the whole app, so a
 * message goes out when its job ends whichever page is open. It needs the app open in
 * a browser: nothing is queued on the server.
 *
 * A message is sent when the thread's last job finished or was cancelled (cancelling
 * with a message waiting is how a job is redirected). After a job that failed, or when
 * the computer can't take a follow-up, it is held instead: the thread shows it with
 * the reason, to send, edit or discard.
 */
import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { t } from '@/lib/i18n'
import { useCodeJob } from './api'
import { useCodeQueue } from './queueStore'
import { holdQueued, holdReason, sendQueued } from './sendQueued'
import { toThreads } from './threads'

function QueuedThread({ threadId, jobId }: { threadId: string; jobId: string }) {
  const qc = useQueryClient()
  const detail = useCodeJob(jobId)
  const data = detail.data
  const gone = detail.isError
  const thread = data ? toThreads(data.thread.length ? data.thread : [data.job])[0] : undefined
  const last = thread?.latest ?? data?.job
  const title = thread?.first.title
  useEffect(() => {
    const message = useCodeQueue.getState().byThread[threadId]
    if (!message || message.held) return
    if (gone) return holdQueued(threadId, message, t('The job can’t be loaded, so this message wasn’t sent.'))
    if (!last || last.state === 'running') return
    const reason = holdReason(last)
    if (reason) holdQueued(threadId, message, reason, title)
    else void sendQueued(qc, threadId, last, title)
  }, [qc, threadId, last, title, gone])
  return null
}

export function CodeQueueRunner() {
  const queue = useCodeQueue((s) => s.byThread)
  return (
    <>
      {Object.entries(queue).map(([threadId, message]) =>
        message.held ? null : <QueuedThread key={threadId} threadId={threadId} jobId={message.jobId} />)}
    </>
  )
}
