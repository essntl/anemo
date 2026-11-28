import { useMemo } from 'react'
import { inScope, useScope } from '@/app/projectStore'
import { usePendingApprovals } from '@/features/agents/api'
import { useAutomations } from '@/features/automations/api'
import { usePlugins } from '@/features/plugins/api'
import { useMemorySummary } from '@/features/memory/api'
import { useTasks } from '@/features/tasks/api'
import { useUpdates } from '@/features/updates/api'
import { today } from '@/features/tasks/dates'
import { plural, t } from '@/lib/i18n'

export interface NeedsRow {
  key: string
  kind: 'approval' | 'question' | 'review' | 'memory' | 'automation' | 'overdue' | 'update'
  title: string
  detail?: string
  to: string
  /** When it started waiting (approvals and questions), to say how long it has waited. */
  since?: string
  /** An approval that can be allowed or denied as it is (not a plan to review or a question). */
  approval?: { id: string; runId: string }
  /** A question (ask_user) that can be answered here: the text and its suggested answers. */
  question?: { id: string; runId: string; text: string; options: string[]; multiple: boolean }
}

/** The kinds that wait for a decision (the Inbox badge counts these); the others are reminders. */
export const DECISIONS: ReadonlySet<NeedsRow['kind']> = new Set(['approval', 'question', 'review', 'automation'])

/**
 * What waits for the user: approvals, questions agents asked, plugins and scripts to
 * review, memory suggestions, failed automations, overdue tasks, and an Anemo update (or
 * what's new after one). Each row says where it is handled.
 */
export function useNeedsYou(): { rows: NeedsRow[]; ready: boolean } {
  const scope = useScope()
  const approvals = usePendingApprovals()
  const memory = useMemorySummary()
  const automations = useAutomations()
  const tasks = useTasks()
  const updates = useUpdates()
  const plugins = usePlugins()
  return useMemo(() => {
    const rows: NeedsRow[] = []
    for (const a of approvals.data ?? []) {
      const to = a.conversation_id ? `/c/${a.conversation_id}` : `/runs/${a.run_id}`
      const where = a.conversation_title ? t('In “{title}”', { title: a.conversation_title }) : undefined
      if (a.kind === 'question') {
        rows.push({
          key: `q-${a.id}`, kind: 'question', title: a.summary || t('The agent has a question for you'), detail: where, to, since: a.created_at,
          question: { id: a.id, runId: a.run_id, text: a.summary, options: a.options ?? [], multiple: a.multiple ?? false },
        })
        continue
      }
      rows.push({
        key: `a-${a.id}`,
        kind: 'approval',
        title: a.kind === 'plan' ? t('A plan to review') : t('Approval needed'),
        detail: [a.summary || a.tool_name, where].filter(Boolean).join(' · ') || undefined,
        to,
        since: a.created_at,
        ...(a.kind !== 'plan' ? { approval: { id: a.id, runId: a.run_id } } : {}),
      })
    }
    for (const p of plugins.data?.plugins ?? []) {
      if (p.status === 'needs_review' || p.update_pending) {
        rows.push({
          key: `p-${p.id}`, kind: 'review', to: `/settings/plugins/${encodeURIComponent(p.id)}`,
          title: p.update_pending && p.status !== 'needs_review' ? t('Plugin update to review: {name}', { name: p.name }) : t('Plugin to review: {name}', { name: p.name }),
          detail: t('Version {version}', { version: p.version }),
        })
      }
    }
    const pending = memory.data?.pending ?? 0
    if (pending) {
      rows.push({ key: 'memory', kind: 'memory', title: plural(pending, '{n} memory suggestion', '{n} memory suggestions'), detail: t('Keep or drop them'), to: '/memory?tab=pending' })
    }
    for (const a of automations.data ?? []) {
      if (a.script_pending) {
        rows.push({ key: `s-${a.id}`, kind: 'review', title: t('Script change to review: {name}', { name: a.name }), detail: t('It stays off until you approve it'), to: '/automations?tab=scripts' })
      }
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
  }, [approvals.data, memory.data, automations.data, tasks.data, updates.data, plugins.data, scope, approvals.isSuccess, memory.isSuccess, automations.isSuccess, tasks.isSuccess])
}
