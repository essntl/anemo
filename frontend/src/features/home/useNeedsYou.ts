import { useMemo } from 'react'
import { useCurrentProject } from '@/app/projectStore'
import { usePendingApprovals } from '@/features/agents/api'
import { useAutomations } from '@/features/automations/api'
import { useMemorySummary } from '@/features/memory/api'
import { useTasks } from '@/features/tasks/api'
import { today } from '@/features/tasks/dates'

export interface NeedsRow {
  key: string
  kind: 'approval' | 'memory' | 'automation' | 'overdue'
  title: string
  detail?: string
  to: string
}

/**
 * What waits for the user: approvals, memory suggestions, failed automations and
 * overdue tasks. Each row says where it is handled.
 */
export function useNeedsYou(): { rows: NeedsRow[]; ready: boolean } {
  const project = useCurrentProject()
  const approvals = usePendingApprovals()
  const memory = useMemorySummary()
  const automations = useAutomations()
  const tasks = useTasks()
  return useMemo(() => {
    const rows: NeedsRow[] = []
    for (const a of approvals.data ?? []) {
      rows.push({
        key: `a-${a.id}`,
        kind: 'approval',
        title: a.kind === 'plan' ? 'A plan to review' : 'Approval needed',
        detail: a.summary || a.tool_name || undefined,
        to: a.conversation_id ? `/c/${a.conversation_id}` : `/runs/${a.run_id}`,
      })
    }
    const pending = memory.data?.pending ?? 0
    if (pending) {
      rows.push({ key: 'memory', kind: 'memory', title: `${pending} memory suggestion${pending === 1 ? '' : 's'}`, detail: 'Keep or drop them', to: '/memory?tab=pending' })
    }
    for (const a of automations.data ?? []) {
      if (a.last_status === 'failed') rows.push({ key: `f-${a.id}`, kind: 'automation', title: `${a.name} failed`, detail: 'Open its history', to: '/automations' })
    }
    const now = today()
    const overdue = (tasks.data ?? []).filter(
      (t) => t.due_date && t.due_date < now && t.status !== 'done' && t.status !== 'cancelled' && (!project || t.project_id === project.id),
    ).length
    if (overdue) rows.push({ key: 'overdue', kind: 'overdue', title: `${overdue} overdue task${overdue === 1 ? '' : 's'}`, to: '/tasks' })
    return { rows, ready: approvals.isSuccess && memory.isSuccess && automations.isSuccess && tasks.isSuccess }
  }, [approvals.data, memory.data, automations.data, tasks.data, project, approvals.isSuccess, memory.isSuccess, automations.isSuccess, tasks.isSuccess])
}
