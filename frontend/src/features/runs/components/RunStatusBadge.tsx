import { Badge } from '@/components/ui/Badge'
import { msg, t } from '@/lib/i18n'

const STATUS: Record<string, { label: string; tone: 'neutral' | 'accent' | 'success' | 'warning' | 'error' }> = {
  queued: { label: msg('Queued'), tone: 'neutral' },
  running: { label: msg('Running'), tone: 'accent' },
  paused: { label: msg('Paused'), tone: 'warning' },
  waiting_approval: { label: msg('Needs you'), tone: 'warning' },
  waiting_subagent: { label: msg('Sub-agent working'), tone: 'accent' },
  completed: { label: msg('Done'), tone: 'success' },
  failed: { label: msg('Failed'), tone: 'error' },
  cancelled: { label: msg('Cancelled'), tone: 'neutral' },
}

export function RunStatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, tone: 'neutral' as const }
  return <Badge tone={s.tone}>{t(s.label)}</Badge>
}
