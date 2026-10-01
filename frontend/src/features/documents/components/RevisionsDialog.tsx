import { useState } from 'react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Markdown } from '@/components/ui/Markdown'
import { cn } from '@/lib/cn'
import { formatWhen } from '@/lib/format'
import { useRestoreRevision, useRevision, useRevisions } from '../api'
import { splitFrontMatter } from '../markdown'

const AUTHORS: Record<string, string> = {
  user: 'You',
  agent: 'An agent',
  external: 'Outside the app',
}

/** A document's saved versions, with a preview and "restore". */
export function RevisionsDialog({ documentId, unsaved, onClose }: { documentId: string; unsaved: boolean; onClose: () => void }) {
  const revisions = useRevisions(documentId, true)
  const [selected, setSelected] = useState<string | null>(null)
  const revision = useRevision(documentId, selected)
  const restore = useRestoreRevision(documentId)
  const chosen = revisions.data?.find((r) => r.id === selected)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} className="md:w-[min(94vw,820px)]"
      title="History" description="Earlier versions of this document. Restoring one keeps the current text in the history.">
      <div className="grid gap-4 md:grid-cols-[14rem_1fr]">
        <div className="flex max-h-48 flex-col gap-1 overflow-y-auto md:max-h-[60vh]">
          {revisions.data?.map((r) => (
            <button key={r.id} type="button" onClick={() => setSelected(r.id)}
              className={cn('rounded-control px-3 py-2 text-left text-[13px] hover:bg-surface-hover',
                selected === r.id && 'bg-accent-soft text-accent')}>
              <div className="font-medium">{formatWhen(r.updated_at)}</div>
              <div className="text-[12px] text-muted">
                {AUTHORS[r.author] ?? r.author}
                {r.current && ' · current'}
              </div>
            </button>
          ))}
          {revisions.data?.length === 0 && <p className="px-3 text-[13px] text-muted">No versions yet.</p>}
        </div>
        <div className="min-w-0">
          {!selected && <p className="text-[13px] text-muted">Choose a version to look at it.</p>}
          {revision.data && (
            <>
              <div className="max-h-[50vh] overflow-y-auto rounded-control border border-border bg-surface px-4 py-3">
                <Markdown text={splitFrontMatter(revision.data.content).body || '*(empty)*'} />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Button variant="primary" size="sm" loading={restore.isPending} disabled={chosen?.current || unsaved}
                  onClick={() => restore.mutate(revision.data.id, { onSuccess: onClose })}>
                  Restore this version
                </Button>
                {chosen?.current && <span className="text-[12.5px] text-muted">This is the current text.</span>}
                {unsaved && !chosen?.current && <span className="text-[12.5px] text-muted">Wait until your changes are saved.</span>}
                {restore.isError && <span className="text-[12.5px] text-error">{errorMessage(restore.error)}</span>}
              </div>
            </>
          )}
        </div>
      </div>
    </Dialog>
  )
}
