import { useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { ShortcutKeys } from '@/features/shortcuts/ShortcutKeys'
import { useShortcut } from '@/hooks/useShortcut'
import { cn } from '@/lib/cn'
import { type ToolCallView, useDecide, useTimeline } from '../api'
import { pendingApproval } from '../question'

/**
 * What the agent asks to do, with Allow once, Allow for this run and Deny. `docked`: the
 * card above the message box, which also answers to the keyboard (see the shortcut list).
 */
export function ApprovalCard({ runId, call, docked }: { runId: string; call: ToolCallView; docked?: boolean }) {
  const decide = useDecide(runId)
  const [denying, setDenying] = useState(false)
  const [reason, setReason] = useState('')
  const approvalId = call.approval!.id
  const busy = decide.isPending
  useShortcut('chat.allow', () => decide.mutate({ approvalId, decision: 'approve', scope: 'once' }), Boolean(docked) && !busy)
  useShortcut('chat.deny', () => setDenying(true), Boolean(docked) && !busy && !denying)
  return (
    <div className={cn('rounded-card border border-warning/40 bg-warning/8 p-3', docked ? 'mb-2' : 'mt-2')}
      role={docked ? 'region' : undefined} aria-label={docked ? 'The agent needs your approval' : undefined}>
      <div className="flex items-start gap-2 text-[13px]">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div className="min-w-0">
          <div className="break-words font-medium">The agent wants to: {call.approval!.summary}</div>
          <div className="text-[12px] text-muted">
            {call.decision_reason} · capability <code className="font-mono">{call.capability}</code>
            {call.risk && call.risk !== 'safe' ? ` · ${call.risk} risk` : ''}
          </div>
        </div>
      </div>
      {denying ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Input
            autoFocus
            placeholder="Optional: tell the agent why"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && decide.mutate({ approvalId, decision: 'deny', reason: reason || undefined })}
            className="h-8 text-[13px]"
          />
          <Button size="sm" variant="danger" loading={busy}
            onClick={() => decide.mutate({ approvalId, decision: 'deny', reason: reason || undefined })}>
            Deny
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDenying(false)}>Back</Button>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" loading={busy}
            onClick={() => decide.mutate({ approvalId, decision: 'approve', scope: 'once' })}>
            Allow once
          </Button>
          {/* Actions that are asked about every time (a click in your own Chrome) can't
              be allowed for the whole run. */}
          {!call.actions.some((a) => a.always_ask) && (
            <Button size="sm" variant="secondary" disabled={busy}
              onClick={() => decide.mutate({ approvalId, decision: 'approve', scope: 'run' })}
              title="Allow the same kind of action in the same folder for the rest of this run">
              Allow for this run
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDenying(true)}>
            Deny
          </Button>
          {docked && (
            <span className="ml-auto hidden items-center gap-3 text-[12px] text-subtle md:flex pointer-coarse:hidden">
              <span className="flex items-center gap-1.5"><ShortcutKeys id="chat.allow" /> allow</span>
              <span className="flex items-center gap-1.5"><ShortcutKeys id="chat.deny" /> deny</span>
            </span>
          )}
        </div>
      )}
      {decide.isError && <p className="mt-2 text-[12px] text-error">{errorMessage(decide.error)}</p>}
    </div>
  )
}

/**
 * The approval a chat's run is waiting for, kept above the message box so it can't
 * scroll out of sight with the run's steps.
 */
export function ApprovalDock({ runId }: { runId: string | null }) {
  const call = pendingApproval(useTimeline(runId).data?.tool_calls)
  if (!runId || !call) return null
  return <ApprovalCard runId={runId} call={call} docked />
}
