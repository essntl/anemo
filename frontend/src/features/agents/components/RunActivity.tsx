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
  Download,
  FileDiff,
  Pause,
  Pencil,
  Undo2,
  Clock,
  Loader2,
  ShieldAlert,
  Wrench,
  XCircle,
} from 'lucide-react'
import { ApiError, errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { confirmDialog } from '@/components/ui/dialogs'
import { Input } from '@/components/ui/Input'
import { toolOutputUrl, useEditPlan } from '@/features/runs/api'
import { cn } from '@/lib/cn'
import { type FileChangeView, type Timeline, type ToolCallView, useDecide, useRevertChange, useTimeline } from '../api'
import { type EditableStep, planIsValid, toEditable } from '../plan'
import { PlanEditor } from './PlanEditor'
import { PlanReviewCard } from './PlanReviewCard'
import { RunControls } from './RunControls'
import { ShellDetails } from './ShellCall'
import { SubagentRun } from './SubagentRun'

const STATUS: Record<string, { icon: typeof Circle; tone: string; label: string }> = {
  pending: { icon: Clock, tone: 'text-muted', label: 'Queued' },
  waiting_approval: { icon: ShieldAlert, tone: 'text-tool-waiting', label: 'Needs approval' },
  running: { icon: Loader2, tone: 'text-tool-running', label: 'Running' },
  waiting_child: { icon: Loader2, tone: 'text-tool-running', label: 'Sub-agent working' },
  succeeded: { icon: CheckCircle2, tone: 'text-tool-ok', label: 'Done' },
  failed: { icon: XCircle, tone: 'text-error', label: 'Failed' },
  denied: { icon: Ban, tone: 'text-tool-denied', label: 'Blocked' },
  cancelled: { icon: Ban, tone: 'text-muted', label: 'Cancelled' },
  interrupted: { icon: XCircle, tone: 'text-warning', label: 'Interrupted' },
}

function describe(call: ToolCallView): string {
  if (call.tool_name === 'load_skill') return `Load skill “${String(call.args.name ?? '')}”`
  if (call.tool_name === 'update_plan' && call.approval?.kind === 'plan') return 'Propose a plan'
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

type WebData = { results?: { title: string; url: string }[]; url?: string; title?: string }

/** Search results and pages the agent read, as links the user can open. */
function WebDetails({ data }: { data: WebData }) {
  const links = data.results ?? (data.url ? [{ title: data.title || data.url, url: data.url }] : [])
  if (!links.length) return null
  return (
    <ul className="space-y-0.5">
      {links.map((l) => (
        <li key={l.url} className="truncate">
          <a href={l.url} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">{l.title}</a>
          <span className="ml-1.5 text-subtle">{new URL(l.url).hostname}</span>
        </li>
      ))}
    </ul>
  )
}

function ToolRow({ runId, call }: { runId: string; call: ToolCallView }) {
  const shell = call.tool_name === 'run_shell'
  // null = not toggled by the user: shell commands open by themselves while running.
  const [toggled, setOpen] = useState<boolean | null>(null)
  // A sub-agent started by this call (its run is shown nested, see SubagentRun).
  const childRunId = call.tool_name === 'run_subagent' ? (call.result_data?.child_run_id as string | undefined) : undefined
  // Open while the sub-agent works, so an approval it asks for is not hidden.
  const open = toggled ?? ((shell && call.status === 'running') || call.status === 'waiting_child')
  const image = shownImage(call)
  const s = STATUS[call.status] ?? STATUS.pending
  const Icon = s.icon
  const needsApproval = call.status === 'waiting_approval' && call.approval?.status === 'pending'
  const output = call.result_data?.output as { chars: number } | undefined
  const web = (call.result_data?.search ?? call.result_data?.web) as WebData | undefined
  return (
    <div className="py-1">
      <button type="button" onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[13px] hover:bg-surface-hover pointer-coarse:py-2.5">
        <Icon className={cn('h-3.5 w-3.5 shrink-0', s.tone, (call.status === 'running' || call.status === 'waiting_child') && 'animate-spin')} />
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
          {shell && <ShellDetails call={call} />}
          {childRunId && <SubagentRun runId={childRunId} />}
          {web && <WebDetails data={web} />}
          {!shell && Object.keys(call.args).length > 0 && (
            <pre className="overflow-x-auto rounded-lg bg-surface-2 p-2 font-mono text-[11.5px]">
              {JSON.stringify(call.args, null, 2)}
            </pre>
          )}
          {!shell && call.result && (
            <pre className={cn('max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-2 font-mono text-[11.5px]',
              call.is_error && 'text-error')}>
              {call.result}
            </pre>
          )}
          {output && (
            <a href={toolOutputUrl(runId, call.id)} target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1 text-accent hover:underline">
              <Download className="h-3.5 w-3.5" /> Full output ({output.chars.toLocaleString()} characters)
            </a>
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
      {needsApproval &&
        (call.approval?.kind === 'plan' ? <PlanReviewCard runId={runId} call={call} /> : <ApprovalCard runId={runId} call={call} />)}
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
      if (err instanceof ApiError && ['changed_since', 'not_empty'].includes(err.code)) {
        const ok = await confirmDialog({
          title: 'Revert anyway?', message: err.message, confirmLabel: 'Revert anyway', danger: true,
        })
        if (ok) await revert.mutateAsync({ changeId: change.id, force: true })
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

function PlanSection({ runId, data }: { runId: string; data: Timeline }) {
  const edit = useEditPlan()
  const [draft, setDraft] = useState<EditableStep[] | null>(null)
  const plan = data.plan ?? []
  // A plan waiting for review is shown (and edited) in its review card instead.
  const inReview = data.tool_calls.some((c) => c.approval?.kind === 'plan' && c.approval.status === 'pending')
  if (!plan.length || inReview) return null
  return (
    <div className="mb-2 px-2">
      <div className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-subtle">
        Plan
        {data.status === 'paused' && !draft && (
          <button type="button" onClick={() => setDraft(toEditable(plan))}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 normal-case tracking-normal text-muted hover:bg-surface-hover hover:text-text">
            <Pencil className="h-3 w-3" /> Edit
          </button>
        )}
      </div>
      {draft ? (
        <div className="rounded-lg border border-border bg-surface p-2">
          <PlanEditor steps={draft} onChange={setDraft} />
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="primary" loading={edit.isPending} disabled={!planIsValid(draft)}
              onClick={() => edit.mutate({ runId, steps: draft }, { onSuccess: () => setDraft(null) })}>
              Save plan
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
          </div>
          <p className="mt-1.5 text-[12px] text-muted">The agent follows the new plan when you resume.</p>
          {edit.isError && <p className="text-[12px] text-error">{errorMessage(edit.error)}</p>}
        </div>
      ) : (
        plan.map((step, i) => {
          const st = String(step.status)
          const StepIcon = st === 'done' ? CheckCircle2 : st === 'in_progress' ? CircleDot : Circle
          return (
            <div key={i} className={cn('flex items-center gap-2 py-0.5 text-[13px]', st === 'skipped' && 'line-through opacity-60')}>
              <StepIcon className={cn('h-3.5 w-3.5 shrink-0', st === 'done' ? 'text-tool-ok' : st === 'in_progress' ? 'text-accent' : 'text-subtle')} />
              {String(step.title)}
            </div>
          )
        })
      )}
    </div>
  )
}

function headline(data: Timeline, live: boolean): string {
  const pending = data.tool_calls.find((c) => c.status === 'waiting_approval' && c.approval?.status === 'pending')
  if (pending) return pending.approval?.kind === 'plan' ? 'Waiting for you to review the plan' : 'Waiting for your approval'
  if (data.status === 'paused') return 'Paused'
  if (live) return 'Working…'
  const n = data.tool_calls.length
  return `${n} action${n === 1 ? '' : 's'}`
}

interface RunActivityProps {
  runId: string
  /** The run is still going: show it expanded. */
  live: boolean
  /** Refresh every 2 s (for a sub-agent, which no chat message follows live). */
  poll?: boolean
}

export function RunActivity({ runId, live, poll }: RunActivityProps) {
  const timeline = useTimeline(runId, poll)
  const [expanded, setExpanded] = useState<boolean | null>(null)
  const data = timeline.data
  const active = Boolean(data && ['queued', 'running', 'paused', 'waiting_subagent'].includes(data.status))
  if (!data || (data.tool_calls.length === 0 && !data.plan && data.file_changes.length === 0 && !active)) return null

  const calls = data.tool_calls
  const waiting = calls.some((c) => c.status === 'waiting_approval') || data.status === 'paused'
  // Expanded while working or waiting; collapsed afterwards unless the user opened it.
  const isOpen = expanded ?? (live || waiting)
  // Nothing to list yet (the agent has only just started): no empty box under the bar.
  const hasDetails = calls.length > 0 || (data.plan?.length ?? 0) > 0 || data.file_changes.length > 0
  // Still going by the run's own status, even if this message no longer follows it live.
  const going = live || active
  const working = going && data.status !== 'paused' && !waiting

  return (
    <div className="mb-3 rounded-xl border border-border bg-surface-2/50">
      <button type="button" onClick={() => setExpanded(!isOpen)}
        className="flex w-full items-center gap-2 px-5 py-2 text-[12.5px] font-medium text-muted hover:text-text pointer-coarse:py-3">
        {data.status === 'paused' ? <Pause className="h-3.5 w-3.5" /> : <Wrench className={cn('h-3.5 w-3.5', working && 'animate-pulse text-accent')} />}
        <span className={cn(working && 'shimmer')}>{headline(data, going)}</span>
        {hasDetails && <ChevronRight className={cn('ml-auto h-3.5 w-3.5 transition-transform', isOpen && 'rotate-90')} />}
      </button>
      {/* px-2 plus the buttons' own padding puts their icons on the text line. */}
      {active && (
        <div className="border-t border-border px-2 py-2">
          <RunControls runId={runId} status={data.status} pauseRequested={data.pause_requested} />
        </div>
      )}
      {isOpen && hasDetails && (
        <div className="border-t border-border px-3 py-2">
          <PlanSection runId={runId} data={data} />
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
