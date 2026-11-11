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
  MessageCircleQuestion,
  ShieldAlert,
  Wrench,
  XCircle,
  Globe,
} from 'lucide-react'
import { ApiError, errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { confirmDialog } from '@/components/ui/dialogs'
import { ZoomableImage } from '@/components/ui/ZoomableImage'
import { FileIcon } from '@/components/ui/FileIcon'
import { toolOutputUrl, useEditPlan, useRun } from '@/features/runs/api'
import { cn } from '@/lib/cn'
import { formatCost, formatCount, formatDuration, formatSize } from '@/lib/format'
import { dateLocale, msg, plural, rich, t } from '@/lib/i18n'
import { type FileChangeView, type Timeline, type ToolCallView, useRevertChange, useTimeline } from '../api'
import { type EditableStep, planIsValid, toEditable } from '../plan'
import { ApprovalCard } from './ApprovalCard'
import { PlanEditor } from './PlanEditor'
import { PlanReviewCard } from './PlanReviewCard'
import { questionOf } from '../question'
import { QuestionCard } from './QuestionCard'
import { RunControls } from './RunControls'
import { ShellDetails } from './ShellCall'
import { SubagentRun } from './SubagentRun'

const STATUS: Record<string, { icon: typeof Circle; tone: string; label: string }> = {
  pending: { icon: Clock, tone: 'text-muted', label: msg('Queued') },
  waiting_approval: { icon: ShieldAlert, tone: 'text-tool-waiting', label: msg('Needs approval') },
  running: { icon: Loader2, tone: 'text-tool-running', label: msg('Running') },
  waiting_child: { icon: Loader2, tone: 'text-tool-running', label: msg('Sub-agent working') },
  succeeded: { icon: CheckCircle2, tone: 'text-tool-ok', label: msg('Done') },
  failed: { icon: XCircle, tone: 'text-error', label: msg('Failed') },
  denied: { icon: Ban, tone: 'text-tool-denied', label: msg('Blocked') },
  cancelled: { icon: Ban, tone: 'text-muted', label: msg('Cancelled') },
  interrupted: { icon: XCircle, tone: 'text-warning', label: msg('Interrupted') },
}

const DECISION: Record<string, string> = { allow: msg('allow'), ask: msg('ask'), deny: msg('deny') }

function describe(call: ToolCallView): string {
  if (call.tool_name === 'ask_user') return t('Ask you: {question}', { question: questionOf(call).question })
  if (call.tool_name === 'load_skill') return t('Load skill “{name}”', { name: String(call.args.name ?? '') })
  if (call.tool_name === 'update_plan' && call.approval?.kind === 'plan') return t('Propose a plan')
  const summary = call.actions.map((a) => (a as { summary?: string }).summary).find(Boolean)
  return summary && summary !== call.tool_name ? summary : call.tool_name.replaceAll('_', ' ')
}

/** The image a tool showed the model (e.g. read_file on a PNG), if any. */
function shownImage(call: ToolCallView): { attachment_id: string; width: number; height: number } | null {
  const image = call.result_data?.image as { attachment_id?: string; width: number; height: number } | undefined
  return image?.attachment_id ? { ...image, attachment_id: image.attachment_id } : null
}

type GivenFile = { attachment_id: string; filename: string; size: number; kind: string }

/** Files the agent gave you (attach_file), as downloads. */
function GivenFiles({ files }: { files: GivenFile[] }) {
  return (
    <div className="ml-7 mt-1 flex flex-wrap gap-1.5">
      {files.map((f) => (
          <a key={f.attachment_id} href={`/api/attachments/${f.attachment_id}/content`} download={f.filename}
            title={t('Download {name}', { name: f.filename })}
            className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1 text-[12px] hover:border-accent/60 hover:text-accent">
            <FileIcon name={f.filename} kind={f.kind} className="h-3.5 w-3.5 shrink-0 text-muted" />
            <span className="truncate">{f.filename}</span>
            <span className="shrink-0 text-subtle">{formatSize(f.size)}</span>
            <Download className="h-3 w-3 shrink-0 text-subtle" />
          </a>
      ))}
    </div>
  )
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

function ToolRow({ runId, call, docked }: { runId: string; call: ToolCallView; docked?: boolean }) {
  const shell = call.tool_name === 'run_shell'
  // null = not toggled by the user: shell commands open by themselves while running.
  const [toggled, setOpen] = useState<boolean | null>(null)
  // A sub-agent started by this call (its run is shown nested, see SubagentRun).
  const childRunId = call.tool_name === 'run_subagent' ? (call.result_data?.child_run_id as string | undefined) : undefined
  // Open while the sub-agent works, so an approval it asks for is not hidden.
  const open = toggled ?? ((shell && call.status === 'running') || call.status === 'waiting_child')
  const image = shownImage(call)
  const asking = call.tool_name === 'ask_user'
  const s = asking && call.status === 'waiting_approval'
    ? { ...STATUS.waiting_approval, icon: MessageCircleQuestion, label: msg('Waiting for you') }
    : asking && call.status === 'succeeded'
      ? { ...STATUS.succeeded, label: questionOf(call).answer ? msg('Answered') : msg('Left to the agent') }
      : (STATUS[call.status] ?? STATUS.pending)
  const Icon = s.icon
  const needsApproval = call.status === 'waiting_approval' && call.approval?.status === 'pending'
  const output = call.result_data?.output as { chars: number } | undefined
  const web = (call.result_data?.search ?? call.result_data?.web) as WebData | undefined
  const given = call.tool_name === 'attach_file' ? (call.result_data?.files as GivenFile[] | undefined) : undefined
  return (
    <div className="py-1">
      <button type="button" onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[13px] hover:bg-surface-hover pointer-coarse:py-2.5">
        <Icon className={cn('h-3.5 w-3.5 shrink-0', s.tone, (call.status === 'running' || call.status === 'waiting_child') && 'animate-spin')} />
        <span className="min-w-0 flex-1 truncate">{describe(call)}</span>
        <span className={cn('shrink-0 text-[11.5px]', s.tone)}>{t(s.label)}</span>
        <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-subtle transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="ml-7 mt-1 space-y-2 text-[12px]">
          <div className="text-muted">
            <span className="font-mono">{call.tool_name}</span>
            {call.decision && <> · {t('permission: {decision} ({reason})', { decision: t(DECISION[call.decision] ?? call.decision), reason: call.decision_reason ?? '' })}</>}
          </div>
          {shell && <ShellDetails call={call} />}
          {childRunId && <SubagentRun runId={childRunId} />}
          {web && <WebDetails data={web} />}
          {asking && (
            <div className="text-muted">
              {questionOf(call).answer ? rich('You answered: <answer></answer>', { answer: () => <span className="text-text">{questionOf(call).answer}</span> }) : t('You left it to the agent.')}
            </div>
          )}
          {!shell && !asking && Object.keys(call.args).length > 0 && (
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
              <Download className="h-3.5 w-3.5" /> {t('Full output ({count} characters)', { count: output.chars.toLocaleString(dateLocale()) })}
            </a>
          )}
        </div>
      )}
      {image && (
        <div className="ml-7 mt-1">
          <ZoomableImage src={`/api/attachments/${image.attachment_id}/content`} alt={t('Image the agent viewed')}
            title={t('What the agent saw ({width}×{height})', { width: image.width, height: image.height })}
            className="max-h-32 max-w-56 rounded-lg border border-border object-contain" />
        </div>
      )}
      {given && given.length > 0 && <GivenFiles files={given} />}
      {needsApproval &&
        (call.approval?.kind === 'plan' ? <PlanReviewCard runId={runId} call={call} />
          : call.approval?.kind === 'question' ? <QuestionCard runId={runId} call={call} />
            : docked
              // The chat keeps the request above its message box (ApprovalDock).
              ? <p className="ml-7 mt-1 text-[12px] font-medium text-tool-waiting">{t('Waiting for you: see above the message box.')}</p>
              : <ApprovalCard runId={runId} call={call} />)}
    </div>
  )
}

const OP_LABEL: Record<string, string> = {
  create: msg('Created'),
  modify: msg('Edited'),
  delete: msg('Deleted'),
  move: msg('Moved'),
  mkdir: msg('Created folder'),
}

function FileChangeRow({ runId, change }: { runId: string; change: FileChangeView }) {
  const revert = useRevertChange(runId)
  const run = async (force = false) => {
    try {
      await revert.mutateAsync({ changeId: change.id, force })
    } catch (err) {
      if (err instanceof ApiError && ['changed_since', 'not_empty'].includes(err.code)) {
        const ok = await confirmDialog({
          title: t('Revert anyway?'), message: err.message, confirmLabel: t('Revert anyway'), danger: true,
        })
        if (ok) await revert.mutateAsync({ changeId: change.id, force: true })
      }
    }
  }
  return (
    <div className="flex items-center gap-2 rounded-lg px-2 py-1 text-[13px]">
      <FileDiff className="h-3.5 w-3.5 shrink-0 text-muted" />
      <span className={cn('min-w-0 flex-1 truncate', change.reverted_at && 'line-through opacity-60')}>
        {t(OP_LABEL[change.op] ?? change.op)} <span className="font-mono text-[12px]">{change.path}</span>
        {change.dest_path && <> → <span className="font-mono text-[12px]">{change.dest_path}</span></>}
      </span>
      {change.reverted_at ? (
        <span className="text-[11.5px] text-muted">{t('Reverted')}</span>
      ) : (
        <Button size="sm" variant="ghost" icon={<Undo2 className="h-3.5 w-3.5" />} loading={revert.isPending}
          onClick={() => void run()}>
          {t('Revert')}
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
        {t('Plan')}
        {data.status === 'paused' && !draft && (
          <button type="button" onClick={() => setDraft(toEditable(plan))}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 normal-case tracking-normal text-muted hover:bg-surface-hover hover:text-text">
            <Pencil className="h-3 w-3" /> {t('Edit')}
          </button>
        )}
      </div>
      {draft ? (
        <div className="rounded-lg border border-border bg-surface p-2">
          <PlanEditor steps={draft} onChange={setDraft} />
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="primary" loading={edit.isPending} disabled={!planIsValid(draft)}
              onClick={() => edit.mutate({ runId, steps: draft }, { onSuccess: () => setDraft(null) })}>
              {t('Save plan')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>{t('Cancel')}</Button>
          </div>
          <p className="mt-1.5 text-[12px] text-muted">{t('The agent follows the new plan when you resume.')}</p>
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
  if (pending?.approval?.kind === 'question') return t('The agent has a question for you')
  if (pending) return pending.approval?.kind === 'plan' ? t('Waiting for you to review the plan') : t('Waiting for your approval')
  if (data.status === 'paused') return t('Paused')
  if (live) return t('Working…')
  const n = data.tool_calls.length
  return plural(n, '{n} action', '{n} actions')
}

interface RunActivityProps {
  runId: string
  /** The run is still going: show it expanded. */
  live: boolean
  /** Refresh every 2 s (for a sub-agent, which no chat message follows live). */
  poll?: boolean
  /** The page shows a pending approval itself (ApprovalDock): don't repeat its buttons here. */
  docked?: boolean
}

export function RunActivity({ runId, live, poll, docked }: RunActivityProps) {
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
        className="flex w-full items-center gap-2 px-3 py-2 text-[12.5px] font-medium text-muted hover:text-text pointer-coarse:py-3">
        {data.status === 'paused' ? <Pause className="h-3.5 w-3.5" /> : <Wrench className={cn('h-3.5 w-3.5', working && 'animate-pulse text-accent')} />}
        <span className={cn(working && 'shimmer')}>{headline(data, going)}</span>
        {hasDetails && <ChevronRight className={cn('ml-auto h-3.5 w-3.5 transition-transform', isOpen && 'rotate-90')} />}
      </button>
      {active && (
        <div className="border-t border-border px-3 py-2">
          <RunControls runId={runId} status={data.status} pauseRequested={data.pause_requested} />
        </div>
      )}
      {isOpen && hasDetails && (
        <div className="border-t border-border px-2 py-2">
          <PlanSection runId={runId} data={data} />
          {calls.map((c) => <ToolRow key={c.id} runId={runId} call={c} docked={docked} />)}
          {data.file_changes.length > 0 && (
            <div className="mt-2 border-t border-border pt-2">
              <div className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-subtle">
                {t('Files changed')}
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

/**
 * A chat's latest agent run at a glance, beside the messages: its plan, how its steps
 * went and the files it changed. The same data as the run's box in the chat.
 */
export function RunPanel({ runId }: { runId: string }) {
  const { data } = useTimeline(runId)
  const run = useRun(runId, { pollWhileActive: true }).data
  if (!data) return <p className="p-4 text-[13px] text-muted">{t('Loading…')}</p>
  const calls = data.tool_calls
  const failed = calls.filter((c) => c.status === 'failed' || c.status === 'denied').length
  const waiting = calls.filter((c) => c.status === 'waiting_approval').length
  const label = 'px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-subtle'
  // The web pages the run opened, each once, in the order it read them.
  const pages = [...new Set(calls.map((c) => c.args.url).filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u)))].slice(0, 12)
  const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url } }
  return (
    <div className="flex flex-col gap-4 p-3">
      <div>
        <div className={label}>{t('Status')}</div>
        <p className="px-2 text-[13px]">{headline(data, ['queued', 'running', 'waiting_subagent'].includes(data.status))}</p>
        <p className="px-2 text-[12px] text-muted">
          {plural(calls.length, '{n} step', '{n} steps')}
          {waiting > 0 && ` · ${plural(waiting, '{n} waiting for you', '{n} waiting for you')}`}
          {failed > 0 && ` · ${t('{n} failed or denied', { n: failed })}`}
        </p>
      </div>
      <PlanSection runId={runId} data={data} />
      {data.file_changes.length > 0 && (
        <div>
          <div className={label}>{t('Files changed')}</div>
          {[...data.file_changes].reverse().map((c) => <FileChangeRow key={c.id} runId={runId} change={c} />)}
        </div>
      )}
      {pages.length > 0 && (
        <div>
          <div className={label}>{t('Pages read')}</div>
          {pages.map((url) => (
            <a key={url} href={url} target="_blank" rel="noreferrer noopener" title={url}
              className="flex h-8 items-center gap-2 rounded-control px-2 text-[13px] hover:bg-surface-hover">
              <Globe className="h-3.5 w-3.5 shrink-0 text-muted" />
              <span className="min-w-0 truncate">{host(url)}</span>
            </a>
          ))}
        </div>
      )}
      {run && (
        <div>
          <div className={label}>{t('Used')}</div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-2 text-[13px]">
            <dt className="text-muted">{t('Model')}</dt><dd className="truncate text-right">{run.model_label ?? '–'}</dd>
            <dt className="text-muted">{t('Working time')}</dt><dd className="text-right tabular-nums">{formatDuration(run.totals.active_s)}</dd>
            <dt className="text-muted">{t('Tokens')}</dt><dd className="text-right tabular-nums">{t('{input} in · {output} out', { input: formatCount(run.totals.input_tokens), output: formatCount(run.totals.output_tokens) })}</dd>
            <dt className="text-muted">{t('Cost')}</dt><dd className="text-right tabular-nums">{formatCost(run.totals.cost_usd)}</dd>
            <dt className="text-muted">{t('Context')}</dt><dd className="text-right">{run.totals.compactions ? t('Summarized {n}×', { n: run.totals.compactions }) : t('Full history')}</dd>
          </dl>
        </div>
      )}
    </div>
  )
}
