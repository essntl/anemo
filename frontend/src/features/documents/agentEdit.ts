import { useState } from 'react'
import { errorMessage } from '@/api/client'
import { confirmDialog } from '@/components/ui/dialogs'
import { toast } from '@/components/ui/toast'
import { t } from '@/lib/i18n'
import { useRestoreRevision, useRevisions } from './api'

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
    // No storage (private mode): the notice comes back on the next visit.
  }
}

/** An agent's edit that was not looked at yet, and what can be done about it. */
export interface AgentEdit {
  /** When the agent saved it (ISO). */
  at: string
  /** Keep the agent's version: the notice goes away. */
  keep: () => void
  /** Go back to the version before it, after asking. Absent when there is none. */
  undo?: () => void
  undoing: boolean
}

/**
 * The document's latest version when an agent wrote it and you have not decided about it
 * yet; null otherwise. Gone once you chose, until an agent edits the document again.
 */
export function useAgentEdit(documentId: string): AgentEdit | null {
  const revisions = useRevisions(documentId, true)
  const restore = useRestoreRevision(documentId)
  const [seen, setSeen] = useState(() => seenVersion(documentId))
  const list = revisions.data ?? []
  const index = list.findIndex((r) => r.current)
  const latest = list[index]
  if (!latest || latest.author !== 'agent' || seen === latest.id) return null
  // The version this one replaced, when there is one.
  const before = list[index + 1]
  const undo = async () => {
    const ok = await confirmDialog({
      title: t('Go back to the version before?'), message: t('The agent’s version stays in the history, so this can be undone there.'), confirmLabel: t('Go back'),
    })
    if (ok && before) restore.mutate(before.id, { onError: (err) => toast({ message: errorMessage(err) }) })
  }
  return {
    at: latest.updated_at,
    keep: () => {
      markSeen(documentId, latest.id)
      setSeen(latest.id)
    },
    undo: before ? () => void undo() : undefined,
    undoing: restore.isPending,
  }
}
