/**
 * One run in full: what was asked, its status and controls, the numbers
 * (time, tokens, cost), and the activity timeline with the final answer.
 * While the run is active it follows the live event stream.
 */
import type { ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router'
import { ArrowLeft, MessageSquare, Square } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Card, CardBody } from '@/components/ui/Card'
import { confirmDialog } from '@/components/ui/dialogs'
import { Markdown } from '@/components/ui/Markdown'
import { timelineKey } from '@/features/agents/api'
import { RunActivity } from '@/features/agents/components/RunActivity'
import { RunControls } from '@/features/agents/components/RunControls'
import { useShellOutput } from '@/features/agents/shellOutput'
import { useCancelRun } from '@/features/chat/api'
import { type RunEvent, TERMINAL, useRunStream } from '@/features/chat/runStream'
import { formatCost, formatCount, formatDuration, formatWhen } from '@/lib/format'
import { runKey, runsKey, runsSummaryKey, useRun } from '../api'
import { RunStatusBadge } from '../components/RunStatusBadge'

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-subtle">{label}</div>
      <div className="mt-0.5 text-[13.5px]">{children}</div>
    </div>
  )
}

export function RunDetailPage() {
  const { runId = '' } = useParams()
  const qc = useQueryClient()
  const run = useRun(runId)
  const cancel = useCancelRun()
  const appendShellOutput = useShellOutput((s) => s.append)
  const data = run.data
  const active = Boolean(data && !TERMINAL.includes(data.status))

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: runKey(runId) })
    void qc.invalidateQueries({ queryKey: timelineKey(runId) })
  }
  const onEvent = (event: RunEvent) => {
    if (event.type === 'tool.progress') {
      appendShellOutput(String(event.data.tool_call_id), String(event.data.text ?? ''))
    } else if (/^(tool|approval|plan|run)\./.test(event.type)) {
      refresh()
    }
  }
  const live = useRunStream(active ? runId : null, () => {
    refresh()
    void qc.invalidateQueries({ queryKey: runsKey })
    void qc.invalidateQueries({ queryKey: runsSummaryKey })
  }, onEvent)

  if (run.isError) return <p className="p-8 text-[13px] text-error">{errorMessage(run.error)}</p>
  if (!data) return null

  const stop = async () => {
    const ok = await confirmDialog({
      title: 'Stop this run?',
      message: 'The agent stops right away. Changes it already made stay, and you can revert file changes below.',
      confirmLabel: 'Stop run',
      danger: true,
    })
    if (ok) cancel.mutate(runId, { onSuccess: refresh })
  }
  const answer = active && live.text ? live.text : data.answer
  const limits = data.limits as { max_steps?: number; max_runtime_s?: number } | null

  return (
    <div className="mx-auto max-w-3xl p-4 md:p-8">
      <Link to="/runs" className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-text">
        <ArrowLeft className="h-4 w-4" /> Runs
      </Link>

      <div className="flex flex-wrap items-center gap-2">
        <RunStatusBadge status={data.status} />
        <span className="text-[12px] text-muted">{formatWhen(data.created_at)}</span>
        {data.parent_run_id && (
          <Link to={`/runs/${data.parent_run_id}`} className="text-[12px] text-accent hover:underline">
            Sub-agent of another run
          </Link>
        )}
      </div>
      <h1 className="mt-2 whitespace-pre-wrap break-words text-lg font-semibold">{data.request || '(no request)'}</h1>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {data.kind === 'agent' && (
          <RunControls runId={runId} status={data.status} pauseRequested={data.pause_requested} withMessage />
        )}
        {active && (
          <Button size="sm" variant="ghost" icon={<Square className="h-3.5 w-3.5" />} loading={cancel.isPending} onClick={() => void stop()}>
            Stop
          </Button>
        )}
        {data.conversation_id && (
          <Link to={`/c/${data.conversation_id}`}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] text-muted hover:bg-surface-hover hover:text-text">
            <MessageSquare className="h-3.5 w-3.5" /> {data.conversation_title ?? 'Open conversation'}
          </Link>
        )}
      </div>

      <Card className="mt-5">
        <CardBody className="grid grid-cols-2 gap-4 py-4 sm:grid-cols-4">
          <Stat label="Agent">{data.kind === 'agent' ? (data.profile_name ?? 'Default agent') : 'Chat'}</Stat>
          <Stat label="Model">{data.model_label ?? '–'}</Stat>
          <Stat label="Working time">{formatDuration(data.totals.active_s)}</Stat>
          <Stat label="Steps">
            {data.step}
            {limits?.max_steps ? <span className="text-subtle"> / {limits.max_steps}</span> : null}
          </Stat>
          <Stat label="Tool calls">{data.totals.tool_calls}</Stat>
          <Stat label="Tokens">
            {formatCount(data.totals.input_tokens)} in · {formatCount(data.totals.output_tokens)} out
          </Stat>
          <Stat label="Cost">{formatCost(data.totals.cost_usd)}</Stat>
          <Stat label="Context">
            {data.totals.compactions ? `Summarized ${data.totals.compactions}×` : 'Full history'}
          </Stat>
        </CardBody>
      </Card>

      {data.error?.message != null && (
        <p className="mt-4 rounded-xl bg-error/10 px-3 py-2 text-[13px] text-error">{String(data.error.message)}</p>
      )}

      {data.memories_used.length > 0 && (
        <details className="mt-4 rounded-xl border border-border bg-surface-2/50 px-3 py-2 text-[13px]">
          <summary className="cursor-pointer text-[12.5px] font-medium text-muted hover:text-text">
            {data.memories_used.length} memor{data.memories_used.length === 1 ? 'y' : 'ies'} in context
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {data.memories_used.map((m) => <li key={m.id}>{m.content}</li>)}
          </ul>
          <Link to="/memory" className="mt-2 inline-block text-[12.5px] text-accent hover:underline">Manage memories</Link>
        </details>
      )}

      <div className="mt-6">
        {data.kind === 'agent' && <RunActivity runId={runId} live={active} />}
        {answer ? (
          <div className="mt-2">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-subtle">Answer</div>
            <Markdown text={answer} />
          </div>
        ) : null}
      </div>
    </div>
  )
}
