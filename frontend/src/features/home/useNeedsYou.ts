import { useMemo } from 'react'
import { inScope, useScope } from '@/app/projectStore'
import { usePendingApprovals } from '@/features/agents/api'
import { useAutomations } from '@/features/automations/api'
import { useMemorySummary } from '@/features/memory/api'
import { useTasks } from '@/features/tasks/api'
import { useUpdates } from '@/features/updates/api'
import { today } from '@/features/tasks/dates'
import { plural, t } from '@/lib/i18n'

export interface NeedsRow {
  key: string
  kind: 'approval' | 'memory' | 'automation' | 'overdue' | 'update'
  title: string
  detail?: string
  to: string
  /** An approval that can be allowed as it is (not a plan to review or a question). */
  approval?: { id: string; runId: string }
}

/**
 * What waits for the user: approvals, memory suggestions, failed automations, overdue
 * tasks, and an Anemo update (or what's new after one). Each row says where it is handled.
 */
export function useNeedsYou(): { rows: NeedsRow[]; ready: boolean } {
  const scope = useScope()
  const approvals = usePendingApprovals()
  const memory = useMemorySummary()
  const automations = useAutomations()
  const tasks = useTasks()
  const updates = useUpdates()
  return useMemo(() => {
    const rows: NeedsRow[] = []
    for (const a of approvals.data ?? []) {
      rows.push({
        key: `a-${a.id}`,
        kind: 'approval',
        title: a.kind === 'plan' ? t('A plan to review') : t('Approval needed'),
        detail: a.summary || a.tool_name || undefined,
        to: a.conversation_id ? `/c/${a.conversation_id}` : `/runs/${a.run_id}`,
        ...(a.kind !== 'plan' && a.kind !== 'question' ? { approval: { id: a.id, runId: a.run_id } } : {}),
      })
    }
    const pending = memory.data?.pending ?? 0
    if (pending) {
      rows.push({ key: 'memory', kind: 'memory', title: plural(pending, '{n} memory suggestion', '{n} memory suggestions'), detail: t('Keep or drop them'), to: '/memory?tab=pending' })
    }
    for (const a of automations.data ?? []) {
      if (a.last_status === 'failed') rows.push({ key: `f-${a.id}`, kind: 'automation', title: t('{name} failed', { name: a.name }), detail: t('Open its history'), to: '/automations' })
    }
    const now = today()
    const overdue = (tasks.data ?? []).filter(
      (t) => t.due_date && t.due_date < now && t.status !== 'done' && t.status !== 'cancelled' && inScope(scope, t.project_id),
    ).length
    if (overdue) rows.push({ key: 'overdue', kind: 'overdue', title: plural(overdue, '{n} overdue task', '{n} overdue tasks'), to: '/tasks' })
    const u = updates.data
    if (u?.whats_new) {
      rows.push({ key: 'whats-new', kind: 'update', title: t('Anemo was updated'), detail: t('See what’s new'), to: '/settings/advanced' })
    } else if (u?.notice) {
      rows.push({ key: 'update', kind: 'update', title: t('An Anemo update is available'), detail: plural(u.behind_by, '{n} new change', '{n} new changes'), to: '/settings/advanced' })
    }
    return { rows, ready: approvals.isSuccess && memory.isSuccess && automations.isSuccess && tasks.isSuccess }
  }, [approvals.data, memory.data, automations.data, tasks.data, updates.data, scope, approvals.isSuccess, memory.isSuccess, automations.isSuccess, tasks.isSuccess])
}
