import { useMemo } from 'react'
import { useTriggers } from '@/features/automations/api'
import { useCodeJobs } from '@/features/code/api'
import { useRuns } from '@/features/runs/api'

export interface InProgressItem {
  key: string
  kind: 'job' | 'wake' | 'automation'
  title: string
  /** The project and computer of a job, what a chat waits for, ... */
  detail?: string
  /** When it started (a job, a run) or was set (a wake-me trigger). */
  since: string
  to: string
}

const RUNNING_JOBS = { project: null, state: 'running' } as const
const ACTIVE_RUNS = { status: 'active', kind: 'agent', q: '' } as const

/**
 * What is going on without the user: Claude Code jobs that are running, chats that wait
 * to be woken by an event (wake-me triggers), and automations that are running. Built from
 * the lists the Code, Automations and Runs pages use; the app's event stream keeps them
 * fresh (code.job, automations.changed, run.status).
 */
export function useInProgress(): { items: InProgressItem[]; ready: boolean } {
  const jobs = useCodeJobs(RUNNING_JOBS)
  const triggers = useTriggers()
  const runs = useRuns(ACTIVE_RUNS)
  return useMemo(() => {
    const items: InProgressItem[] = []
    for (const j of jobs.data?.pages.flatMap((p) => p.jobs) ?? []) {
      if (j.state !== 'running') continue
      items.push({ key: `j-${j.id}`, kind: 'job', title: j.title || j.prompt, detail: [j.project, j.device.name].filter(Boolean).join(' · '), since: j.started_at, to: `/code/${j.id}` })
    }
    for (const tr of triggers.data ?? []) {
      if (tr.kind !== 'wake' || !tr.enabled || !tr.conversation_id) continue
      items.push({
        key: `w-${tr.id}`, kind: 'wake', title: tr.conversation_title || tr.event_label,
        detail: tr.note || tr.event_label, since: tr.created_at, to: `/c/${tr.conversation_id}`,
      })
    }
    for (const r of runs.data?.pages.flat() ?? []) {
      if (!r.automation_id) continue
      items.push({ key: `r-${r.id}`, kind: 'automation', title: r.automation_name || r.request, detail: r.model_label ?? undefined, since: r.started_at ?? r.created_at, to: `/runs/${r.id}` })
    }
    return { items, ready: jobs.isSuccess && triggers.isSuccess && runs.isSuccess }
  }, [jobs.data, triggers.data, runs.data, jobs.isSuccess, triggers.isSuccess, runs.isSuccess])
}
