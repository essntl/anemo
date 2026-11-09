/**
 * What an agent run did, compactly, and the approval it is waiting for. Uses Anemo's
 * approval API as is: the same decision path as Anemo's own cards. Approvals only ever
 * come from a click here; nothing on a web page can answer one.
 */
import { useState } from 'react'
import { Check, ChevronDown, CircleSlash, ExternalLink, Loader2, MessageCircleQuestion, ShieldAlert, Wrench, X } from 'lucide-react'
import { Button } from '../ui/Button'
import { Textarea } from '../ui/Input'
import { cn } from '../lib/cn'
import { useSession } from '../state/useSession'
import { useDecide, useTimeline, type ToolCall } from './api'

const STATUS: Record<string, { icon: typeof Check; tone: string; label: string }> = {
  pending: { icon: Loader2, tone: 'text-tool-running', label: 'Starting' },
  running: { icon: Loader2, tone: 'text-tool-running', label: 'Running' },
  completed: { icon: Check, tone: 'text-tool-ok', label: 'Done' },
  failed: { icon: X, tone: 'text-tool-denied', label: 'Failed' },
  denied: { icon: CircleSlash, tone: 'text-tool-denied', label: 'Denied' },
  waiting_approval: { icon: ShieldAlert, tone: 'text-tool-waiting', label: 'Needs approval' },
  interrupted: { icon: CircleSlash, tone: 'text-muted', label: 'Interrupted' },
}

function ErrorLine({ error }: { error: Error | null }) {
  return error ? <p className="text-[12px] text-error">{error.message}</p> : null
}

function ActionApproval({ call }: { call: ToolCall }) {
  const decide = useDecide()
  const [denying, setDenying] = useState(false)
  const [reason, setReason] = useState('')
  const [showArgs, setShowArgs] = useState(false)
  const approvalId = call.approval!.id
  return (
    <div className="flex flex-col gap-2 rounded-control border border-warning/40 bg-warning/5 p-2.5" data-testid="approval-card">
      <div className="text-[13px] font-medium">The agent wants to: {call.approval!.summary}</div>
      <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted">
        <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono">{call.tool_name}</span>
        {call.risk && <span className={cn('rounded px-1.5 py-0.5', call.risk === 'dangerous' ? 'bg-error/10 text-error' : 'bg-surface-2')}>{call.risk}</span>}
        <button type="button" className="flex items-center gap-0.5 hover:text-text" onClick={() => setShowArgs((v) => !v)} aria-expanded={showArgs}>
          details <ChevronDown className={cn('h-3 w-3 transition-transform', showArgs && 'rotate-180')} />
        </button>
      </div>
      {showArgs && (
        <pre className="max-h-48 overflow-auto rounded-md bg-surface-2 p-2 font-mono text-[11.5px] leading-relaxed">{JSON.stringify(call.args, null, 2)}</pre>
      )}
      {denying ? (
        <div className="flex flex-col gap-2">
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why not? (optional, the agent sees it)" maxLength={500} />
          <div className="flex gap-2">
            <Button size="sm" variant="danger" loading={decide.isPending} onClick={() => decide.mutate({ approvalId, decision: 'deny', reason: reason.trim() || null })}>Deny</Button>
            <Button size="sm" variant="ghost" onClick={() => setDenying(false)}>Back</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="primary" loading={decide.isPending} onClick={() => decide.mutate({ approvalId, decision: 'approve', scope: 'once' })}>Allow once</Button>
          <Button size="sm" onClick={() => decide.mutate({ approvalId, decision: 'approve', scope: 'run' })} disabled={decide.isPending} title="Allow this kind of action in the same place for the rest of this run">
            Allow for this run
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDenying(true)} disabled={decide.isPending}>Deny…</Button>
        </div>
      )}
      <ErrorLine error={decide.error} />
    </div>
  )
}

function PlanApproval({ call, conversationId }: { call: ToolCall; conversationId: string }) {
  const decide = useDecide()
  const { connection } = useSession()
  const [denying, setDenying] = useState(false)
  const [reason, setReason] = useState('')
  const steps = ((call.args.steps as { title?: string }[] | undefined) ?? []).map((s) => s.title ?? '')
  const approvalId = call.approval!.id
  return (
    <div className="flex flex-col gap-2 rounded-control border border-warning/40 bg-warning/5 p-2.5" data-testid="approval-card">
      <div className="text-[13px] font-medium">The agent proposes a plan</div>
      <ol className="list-decimal pl-5 text-[12.5px]">
        {steps.map((s, i) => <li key={i}>{s}</li>)}
      </ol>
      {denying ? (
        <div className="flex flex-col gap-2">
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What should change? (the agent sees it)" maxLength={500} />
          <div className="flex gap-2">
            <Button size="sm" variant="danger" loading={decide.isPending} onClick={() => decide.mutate({ approvalId, decision: 'deny', reason: reason.trim() || null })}>Send back</Button>
            <Button size="sm" variant="ghost" onClick={() => setDenying(false)}>Back</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="primary" loading={decide.isPending} onClick={() => decide.mutate({ approvalId, decision: 'approve' })}>Approve plan</Button>
          <Button size="sm" variant="ghost" onClick={() => setDenying(true)} disabled={decide.isPending}>Send back…</Button>
          <a className="inline-flex h-8 items-center gap-1 rounded-control px-2 text-[13px] text-muted hover:bg-surface-hover hover:text-text" href={`${connection.serverUrl}/c/${conversationId}`} target="_blank" rel="noopener noreferrer">
            Edit steps in Anemo <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      )}
      <ErrorLine error={decide.error} />
    </div>
  )
}

function QuestionApproval({ call }: { call: ToolCall }) {
  const decide = useDecide()
  const question = String(call.args.question ?? call.approval?.summary ?? '')
  const options = ((call.args.options as string[] | undefined) ?? []).filter(Boolean)
  const [answer, setAnswer] = useState('')
  const approvalId = call.approval!.id
  const send = (text: string) => decide.mutate({ approvalId, decision: 'approve', answer: text })
  return (
    <div className="flex flex-col gap-2 rounded-control border border-accent/30 bg-accent-soft p-2.5" data-testid="approval-card">
      <div className="flex gap-1.5 text-[13px] font-medium"><MessageCircleQuestion className="mt-0.5 h-4 w-4 shrink-0 text-accent" />{question}</div>
      {options.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {options.map((o) => <Button key={o} size="sm" onClick={() => send(o)} disabled={decide.isPending}>{o}</Button>)}
        </div>
      )}
      <Textarea rows={2} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Your answer" maxLength={4000} />
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="primary" disabled={!answer.trim()} loading={decide.isPending} onClick={() => send(answer.trim())}>Answer</Button>
        <Button size="sm" variant="ghost" disabled={decide.isPending} onClick={() => decide.mutate({ approvalId, decision: 'deny' })}>Let the agent decide</Button>
      </div>
      <ErrorLine error={decide.error} />
    </div>
  )
}

/** The tool calls of an agent run, and the card for the one waiting on you. */
export function AgentActivity({ runId, version, conversationId }: { runId: string; version: number; conversationId: string }) {
  const timeline = useTimeline(runId, version)
  const calls = timeline.data?.tool_calls ?? []
  if (calls.length === 0) return null
  return (
    <div className="flex flex-col gap-1.5" aria-label="Agent activity">
      {calls.map((call) => {
        const s = STATUS[call.status] ?? { icon: Wrench, tone: 'text-muted', label: call.status }
        const Icon = s.icon
        const waiting = call.status === 'waiting_approval' && call.approval?.status === 'pending'
        return (
          <div key={call.id} className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5 text-[12px] text-muted">
              <Icon className={cn('h-3.5 w-3.5 shrink-0', s.tone, Icon === Loader2 && 'animate-spin')} aria-label={s.label} />
              <span className="truncate">{call.approval?.summary ?? call.actions[0]?.summary as string ?? call.tool_name}</span>
            </div>
            {waiting && call.approval?.kind === 'plan' && <PlanApproval call={call} conversationId={conversationId} />}
            {waiting && call.approval?.kind === 'question' && <QuestionApproval call={call} />}
            {waiting && call.approval?.kind === 'action' && <ActionApproval call={call} />}
          </div>
        )
      })}
    </div>
  )
}
