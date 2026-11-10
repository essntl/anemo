import { useState } from 'react'
import { Bot } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { confirmDialog } from '@/components/ui/dialogs'
import { toast } from '@/components/ui/toast'
import { formatWhen } from '@/lib/format'
import { useRestoreRevision, useRevisions } from '../api'

/** Browser storage: per document, the agent's version that was already looked at. */
const SEEN = 'anemo.docAgentEdits'

function seenVersion(documentId: string): string | null {
  try {
    return (JSON.parse(localStorage.getItem(SEEN) ?? '{}') as Record<string, string>)[documentId] ?? null
  } catch {
    return null
  }
}

function markSeen(documentId: string, revisionId: string): void {
  try {
    const all = JSON.parse(localStorage.getItem(SEEN) ?? '{}') as Record<string, string>
    localStorage.setItem(SEEN, JSON.stringify({ ...all, [documentId]: revisionId }))
  } catch {
    // No storage (private mode): the bar comes back on the next visit.
  }
}

/**
 * Above a document whose latest version was written by an agent: says so, and offers to
 * look at the versions, keep it, or go back to the version before it. Gone once you
 * chose, until an agent edits the document again.
 */
export function AgentEditBar({ documentId, onReview }: { documentId: string; onReview: () => void }) {
  const revisions = useRevisions(documentId, true)
  const restore = useRestoreRevision(documentId)
  const [seen, setSeen] = useState(() => seenVersion(documentId))
  const list = revisions.data ?? []
  const index = list.findIndex((r) => r.current)
  const latest = list[index]
  if (!latest || latest.author !== 'agent' || seen === latest.id) return null
  // The version this one replaced, when there is one.
  const before = list[index + 1]
  const keep = () => {
    markSeen(documentId, latest.id)
    setSeen(latest.id)
  }
  const undo = async () => {
    if (!before) return
    const ok = await confirmDialog({
      title: 'Go back to the version before?', message: 'The agent’s version stays in the history, so this can be undone there.', confirmLabel: 'Go back',
    })
    if (ok) restore.mutate(before.id, { onError: (err) => toast({ message: errorMessage(err) }) })
  }
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 border-b border-border bg-accent-soft px-4 py-2 text-[13px]">
      <Bot className="h-4 w-4 shrink-0 text-accent" />
      <span className="min-w-40 flex-1">
        <span className="font-medium">An agent edited this document</span>
        <span className="text-muted"> · {formatWhen(latest.updated_at)}</span>
      </span>
      <Button size="sm" variant="secondary" onClick={onReview}>Review</Button>
      <Button size="sm" variant="ghost" onClick={keep}>Keep</Button>
      {before && <Button size="sm" variant="ghost" loading={restore.isPending} onClick={() => void undo()}>Undo</Button>}
    </div>
  )
}
