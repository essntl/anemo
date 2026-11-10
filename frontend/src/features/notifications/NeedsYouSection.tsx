import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { AlarmClock, Brain, Clock, ShieldQuestion, Sparkles } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { toast } from '@/components/ui/toast'
import { useDecide } from '@/features/agents/api'
import { type NeedsRow, useNeedsYou } from '@/features/home/useNeedsYou'
import { cn } from '@/lib/cn'

const ICON: Record<NeedsRow['kind'], ReactNode> = {
  approval: <ShieldQuestion />,
  memory: <Brain />,
  automation: <Clock />,
  overdue: <AlarmClock />,
  update: <Sparkles />,
}
const TONE: Record<NeedsRow['kind'], string> = {
  approval: 'text-warning', memory: 'text-warning', automation: 'text-error', overdue: 'text-error', update: 'text-accent',
}

/** Allow what an agent asks for, once, without opening its chat. */
function AllowOnce({ approval }: { approval: NonNullable<NeedsRow['approval']> }) {
  const decide = useDecide(approval.runId)
  return (
    <Button size="sm" variant="primary" loading={decide.isPending}
      onClick={() => decide.mutate({ approvalId: approval.id, decision: 'approve', scope: 'once' }, { onError: (err) => toast({ message: errorMessage(err) }) })}>
      Allow once
    </Button>
  )
}

/**
 * The top of the Inbox: what waits for you (approvals, failed automations, overdue
 * tasks, an update). A plain approval can be allowed right here;
 * every row opens the place where it is handled. Nothing is drawn while nothing waits.
 */
export function NeedsYouSection() {
  // Memory suggestions are handled on the Memory page (and counted there), not in the Inbox.
  const rows = useNeedsYou().rows.filter((r) => r.kind !== 'memory')
  if (rows.length === 0) return null
  return (
    <section aria-label="Needs you" className="mb-5 rounded-card border border-border bg-card shadow-soft">
      <h2 className="flex h-11 items-center gap-2 border-b border-border px-4 text-[13.5px] font-semibold">
        <span className="flex-1">Needs you</span>
        <span className="rounded-full bg-warning px-2 py-0.5 text-[11px] font-semibold text-white">{rows.length}</span>
      </h2>
      <ul>
        {rows.map((r) => (
          <li key={r.key} className="flex min-h-13 items-center gap-3 border-b border-border px-4 py-2 last:border-b-0">
            <span aria-hidden className={cn('shrink-0 [&>svg]:h-4 [&>svg]:w-4', TONE[r.kind])}>{ICON[r.kind]}</span>
            <Link to={r.to} className="min-w-0 flex-1 hover:text-accent">
              <span className="block truncate text-[13.5px] font-medium">{r.title}</span>
              {r.detail && <span className="block truncate text-[12px] text-muted">{r.detail}</span>}
            </Link>
            {r.approval && <AllowOnce approval={r.approval} />}
            <Link to={r.to} className="inline-flex h-8 shrink-0 items-center rounded-control bg-surface-2 px-3 text-[13px] font-medium hover:bg-surface-hover pointer-coarse:h-10">
              Open
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
