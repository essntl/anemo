/**
 * A sub-agent, shown inside the tool call that started it: its status, a link to
 * its own run page, and its activity (which is the same timeline again, nested).
 * If the sub-agent needs your approval, the request appears here.
 */
import { Link } from 'react-router'
import { ExternalLink } from 'lucide-react'
import { TERMINAL } from '@/features/chat/runStream'
import { useRun } from '@/features/runs/api'
import { RunStatusBadge } from '@/features/runs/components/RunStatusBadge'
import { RunActivity } from './RunActivity'

export function SubagentRun({ runId }: { runId: string }) {
  // A sub-agent has no chat message that follows it live, so look again every 2 s while it works.
  const run = useRun(runId, { pollWhileActive: true })
  if (!run.data) return null
  const working = !TERMINAL.includes(run.data.status)
  return (
    <div className="rounded-lg border border-border">
      <div className="flex flex-wrap items-center gap-2 px-2.5 py-1.5">
        <span className="font-medium">Sub-agent</span>
        {run.data.profile_name && <span className="text-muted">{run.data.profile_name}</span>}
        <RunStatusBadge status={run.data.status} />
        <Link to={`/runs/${runId}`} className="ml-auto inline-flex items-center gap-1 text-accent hover:underline">
          Open <ExternalLink className="h-3 w-3" />
        </Link>
      </div>
      <div className="px-1.5 [&>div]:mb-1.5">
        <RunActivity runId={runId} live={working} poll={working} />
      </div>
    </div>
  )
}
