import { Badge } from '@/components/ui/Badge'

const STATUS: Record<string, { label: string; tone: 'neutral' | 'accent' | 'success' | 'warning' | 'error' }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Running', tone: 'accent' },
  paused: { label: 'Paused', tone: 'warning' },
  waiting_approval: { label: 'Needs you', tone: 'warning' },
  waiting_subagent: { label: 'Sub-agent working', tone: 'accent' },
  completed: { label: 'Done', tone: 'success' },
  failed: { label: 'Failed', tone: 'error' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
}

export function RunStatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, tone: 'neutral' as const }
  return <Badge tone={s.tone}>{s.label}</Badge>
}
