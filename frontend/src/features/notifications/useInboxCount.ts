import { usePendingApprovals } from '@/features/agents/api'
import { useAutomations } from '@/features/automations/api'
import { usePlugins } from '@/features/plugins/api'
import { useNotificationSummary } from './api'

/**
 * What the Inbox badge counts. `decisions`: what waits for the user to decide: approvals
 * and questions, plugins and scripts to review, automations that failed (the same rows as
 * Needs you, without overdue tasks and updates, which have their own places). `unread`:
 * unread notifications. Built from lists the app keeps fresh through its event stream.
 */
export function useInboxCount(): { decisions: number; unread: number } {
  const approvals = usePendingApprovals().data?.length ?? 0
  const automations = useAutomations().data ?? []
  const plugins = usePlugins().data?.plugins ?? []
  const unread = useNotificationSummary().data?.unread ?? 0
  const reviews = plugins.filter((p) => p.status === 'needs_review' || p.update_pending).length
    + automations.filter((a) => a.script_pending).length
  const failed = automations.filter((a) => a.last_status === 'failed').length
  return { decisions: approvals + reviews + failed, unread }
}
