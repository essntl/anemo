/**
 * What an agent did during a run: its plan, each tool call with the permission
 * decision and result, and — when the run is paused — the approval request.
 *
 * Data comes from GET /api/runs/{id}/timeline (the database), refreshed whenever
 * the run's live stream reports a tool/approval/plan event. The database is the
 * source of truth, so this renders correctly after a reload or days later.
 */
import { useState } from 'react'
import {
  Ban,
  CheckCircle2,
  ChevronRight,
  Circle,
  CircleDot,
  FileDiff,
  Undo2,
  Clock,
  Loader2,
  ShieldAlert,
  Wrench,
  XCircle,
} from 'lucide-react'
import { ApiError, errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { cn } from '@/lib/cn'
import { type FileChangeView, type ToolCallView, useDecide, useRevertChange, useTimeline } from '../api'

const STATUS: Record<string, { icon: typeof Circle; tone: string; label: string }> = {
  pending: { icon: Clock, tone: 'text-muted', label: 'Queued' },
  waiting_approval: { icon: ShieldAlert, tone: 'text-tool-waiting', label: 'Needs approval' },
  running: { icon: Loader2, tone: 'text-tool-running', label: 'Running' },
  succeeded: { icon: CheckCircle2, tone: 'text-tool-ok', label: 'Done' },
  failed: { icon: XCircle, tone: 'text-error', label: 'Failed' },
  denied: { icon: Ban, tone: 'text-tool-denied', label: 'Blocked' },
  cancelled: { icon: Ban, tone: 'text-muted', label: 'Cancelled' },
  interrupted: { icon: XCircle, tone: 'text-warning', label: 'Interrupted' },
}

function describe(call: ToolCallView): string {
  const summary = call.actions.map((a) => (a as { summary?: string }).summary).find(Boolean)
  return summary && summary !== call.tool_name ? summary : call.tool_name.replaceAll('_', ' ')
}

function ApprovalCard({ runId, call }: { runId: string; call: ToolCallView }) {
  const decide = useDecide(runId)
  const [denying, setDenying] = useState(false)
  const [reason, setReason] = useState('')
  const approvalId = call.approval!.id
  return (
    <div className="mt-2 rounded-xl border border-warning/40 bg-warning/8 p-3">
      <div className="flex items-start gap-2 text-[13px]">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div>
          <div className="font-medium">The agent wants to: {call.approval!.summary}</div>
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
            className="h-8 text-[13px]"
          />
          <Button size="sm" variant="danger" loading={decide.isPending}
            onClick={() => decide.mutate({ approvalId, decision: 'deny', reason: reason || undefined })}>
            Deny
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDenying(false)}>Back</Button>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="primary" loading={decide.isPending}
            onClick={() => decide.mutate({ approvalId, decision: 'approve', scope: 'once' })}>
            Allow once
          </Button>
          <Button size="sm" variant="secondary" disabled={decide.isPending}
            onClick={() => decide.mutate({ approvalId, decision: 'approve', scope: 'run' })}
            title="Allow the same kind of action in the same folder for the rest of this run">
            Allow for this run
          </Button>
          <Button size="sm" variant="ghost" disabled={decide.isPending} onClick={() => setDenying(true)}>
            Deny
          </Button>
        </div>
      )}
      {decide.isError && <p className="mt-2 text-[12px] text-error">{errorMessage(decide.error)}</p>}
    </div>
  )
}

/** The image a tool showed the model (e.g. read_file on a PNG), if any. */
function shownImage(call: ToolCallView): { attachment_id: string; width: number; height: number } | null {
  const image = call.result_data?.image as { attachment_id?: string; width: number; height: number } | undefined
  return image?.attachment_id ? { ...image, attachment_id: image.attachment_id } : null
}

function ToolRow({ runId, call }: { runId: string; call: ToolCallView }) {
  const [open, setOpen] = useState(false)
  const image = shownImage(call)
  const s = STATUS[call.status] ?? STATUS.pending
  const Icon = s.icon
  const needsApproval = call.status === 'waiting_approval' && call.approval?.status === 'pending'
  return (
    <div className="py-1">
      <button type="button" onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[13px] hover:bg-surface-hover pointer-coarse:py-2.5">
        <Icon className={cn('h-3.5 w-3.5 shrink-0', s.tone, call.status === 'running' && 'animate-spin')} />
        <span className="min-w-0 flex-1 truncate">{describe(call)}</span>
        <span className={cn('shrink-0 text-[11.5px]', s.tone)}>{s.label}</span>
        <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-subtle transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="ml-7 mt-1 space-y-2 text-[12px]">
          <div className="text-muted">
            <span className="font-mono">{call.tool_name}</span>
            {call.decision && <> · permission: {call.decision} ({call.decision_reason})</>}
          </div>
          {Object.keys(call.args).length > 0 && (
            <pre className="overflow-x-auto rounded-lg bg-surface-2 p-2 font-mono text-[11.5px]">
              {JSON.stringify(call.args, null, 2)}
            </pre>
          )}
          {call.result && (
            <pre className={cn('max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-2 font-mono text-[11.5px]',
              call.is_error && 'text-error')}>
              {call.result}
            </pre>
          )}
        </div>
      )}
      {image && (
        <a href={`/api/attachments/${image.attachment_id}/content`} target="_blank" rel="noreferrer"
          className="ml-7 mt-1 inline-block" title={`What the agent saw (${image.width}×${image.height})`}>
          <img src={`/api/attachments/${image.attachment_id}/content`} alt="Image the agent viewed"
            className="max-h-32 max-w-56 rounded-lg border border-border object-contain" />
        </a>
      )}
      {needsApproval && <ApprovalCard runId={runId} call={call} />}
    </div>
  )
}

const OP_LABEL: Record<string, string> = {
  create: 'Created',
  modify: 'Edited',
  delete: 'Deleted',
  move: 'Moved',
  mkdir: 'Created folder',
}

function FileChangeRow({ runId, change }: { runId: string; change: FileChangeView }) {
  const revert = useRevertChange(runId)
  const run = async (force = false) => {
    try {
      await revert.mutateAsync({ changeId: change.id, force })
    } catch (err) {
      if (err instanceof ApiError && ['changed_since', 'not_empty'].includes(err.code) &&
          window.confirm(`${err.message}`)) {
        await revert.mutateAsync({ changeId: change.id, force: true })
      }
    }
  }
  return (
    <div className="flex items-center gap-2 rounded-lg px-2 py-1 text-[13px]">
      <FileDiff className="h-3.5 w-3.5 shrink-0 text-muted" />
      <span className={cn('min-w-0 flex-1 truncate', change.reverted_at && 'line-through opacity-60')}>
        {OP_LABEL[change.op] ?? change.op} <span className="font-mono text-[12px]">{change.path}</span>
        {change.dest_path && <> → <span className="font-mono text-[12px]">{change.dest_path}</span></>}
      </span>
      {change.reverted_at ? (
        <span className="text-[11.5px] text-muted">Reverted</span>
      ) : (
        <Button size="sm" variant="ghost" icon={<Undo2 className="h-3.5 w-3.5" />} loading={revert.isPending}
          onClick={() => void run()}>
          Revert
        </Button>
      )}
      {revert.isError && !(revert.error instanceof ApiError && revert.error.code === 'changed_since') && (
        <span className="text-[11.5px] text-error">{errorMessage(revert.error)}</span>
      )}
    </div>
  )
}

export function RunActivity({ runId, live }: { runId: string; live: boolean }) {
  const timeline = useTimeline(runId)
  const [expanded, setExpanded] = useState<boolean | null>(null)
  const data = timeline.data
  if (!data || (data.tool_calls.length === 0 && !data.plan && data.file_changes.length === 0)) return null

  const calls = data.tool_calls
  const waiting = calls.some((c) => c.status === 'waiting_approval')
  // Expanded while working or waiting; collapsed afterwards unless the user opened it.
  const isOpen = expanded ?? (live || waiting)

  return (
    <div className="mb-3 rounded-xl border border-border bg-surface-2/50">
      <button type="button" onClick={() => setExpanded(!isOpen)}
        className="flex w-full items-center gap-2 px-3 py-2 text-[12.5px] font-medium text-muted hover:text-text pointer-coarse:py-3">
        <Wrench className="h-3.5 w-3.5" />
        {waiting ? 'Waiting for your approval' : live ? 'Working…' : `${calls.length} action${calls.length === 1 ? '' : 's'}`}
        <ChevronRight className={cn('ml-auto h-3.5 w-3.5 transition-transform', isOpen && 'rotate-90')} />
      </button>
      {isOpen && (
        <div className="border-t border-border px-2 py-2">
          {data.plan && data.plan.length > 0 && (
            <div className="mb-2 px-2">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-subtle">Plan</div>
              {data.plan.map((step, i) => {
                const st = String(step.status)
                const StepIcon = st === 'done' ? CheckCircle2 : st === 'in_progress' ? CircleDot : Circle
                return (
                  <div key={i} className={cn('flex items-center gap-2 py-0.5 text-[13px]', st === 'skipped' && 'line-through opacity-60')}>
                    <StepIcon className={cn('h-3.5 w-3.5', st === 'done' ? 'text-tool-ok' : st === 'in_progress' ? 'text-accent' : 'text-subtle')} />
                    {String(step.title)}
                  </div>
                )
              })}
            </div>
          )}
          {calls.map((c) => <ToolRow key={c.id} runId={runId} call={c} />)}
          {data.file_changes.length > 0 && (
            <div className="mt-2 border-t border-border pt-2">
              <div className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-subtle">
                Files changed
              </div>
              {[...data.file_changes].reverse().map((c) => (
                <FileChangeRow key={c.id} runId={runId} change={c} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
