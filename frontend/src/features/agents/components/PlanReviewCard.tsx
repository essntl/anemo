import { useState } from 'react'
import { ListChecks } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { type ToolCallView, useDecide } from '../api'
import { type EditableStep, planIsValid, toEditable } from '../plan'
import { PlanEditor } from './PlanEditor'

/**
 * Plan review: the agent proposed a plan and waits. The user can accept it,
 * change the steps first, or send it back with feedback.
 */
export function PlanReviewCard({ runId, call }: { runId: string; call: ToolCallView }) {
  const decide = useDecide(runId)
  const proposed = toEditable((call.args.steps as Record<string, unknown>[] | undefined) ?? [])
  const [steps, setSteps] = useState<EditableStep[]>(proposed)
  const [editing, setEditing] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [feedback, setFeedback] = useState('')
  const approvalId = call.approval!.id
  const edited = JSON.stringify(steps) !== JSON.stringify(proposed)

  return (
    <div className="mt-2 rounded-xl border border-accent/40 bg-accent-soft/40 p-3">
      <div className="flex items-start gap-2 text-[13px]">
        <ListChecks className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        <div>
          <div className="font-medium">Review the agent's plan</div>
          <div className="text-[12px] text-muted">Nothing happens until you approve it. You can change the steps first.</div>
        </div>
      </div>
      <div className="mt-3">
        {editing ? (
          <PlanEditor steps={steps} onChange={setSteps} />
        ) : (
          <ol className="list-decimal space-y-0.5 pl-6 text-[13px]">
            {steps.map((s, i) => <li key={i}>{s.title}</li>)}
          </ol>
        )}
      </div>
      {rejecting ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Input autoFocus placeholder="What should change? (sent to the agent)" value={feedback}
            onChange={(e) => setFeedback(e.target.value)} className="h-8 min-w-48 flex-1 text-[13px]" />
          <Button size="sm" variant="danger" loading={decide.isPending}
            onClick={() => decide.mutate({ approvalId, decision: 'deny', reason: feedback || undefined })}>
            Send back
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setRejecting(false)}>Back</Button>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="primary" loading={decide.isPending} disabled={!planIsValid(steps)}
            onClick={() => decide.mutate({ approvalId, decision: 'approve', plan: edited ? steps : undefined })}>
            {edited ? 'Approve edited plan' : 'Approve plan'}
          </Button>
          {!editing && <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>Edit steps</Button>}
          {edited && <Button size="sm" variant="ghost" onClick={() => setSteps(proposed)}>Undo changes</Button>}
          <Button size="sm" variant="ghost" disabled={decide.isPending} onClick={() => setRejecting(true)}>
            Reject
          </Button>
        </div>
      )}
      {decide.isError && <p className="mt-2 text-[12px] text-error">{errorMessage(decide.error)}</p>}
    </div>
  )
}
