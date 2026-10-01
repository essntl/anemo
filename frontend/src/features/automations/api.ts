import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, type Schemas, unwrap } from '@/api/client'
import { runsKey, runsSummaryKey } from '@/features/runs/api'
import type { Schedule } from './scheduleForm'

export type Automation = Schemas['AutomationOut']
export type AutomationInput = Required<Schemas['AutomationIn']>
export type OnAsk = Automation['on_ask']
export type NotifyWhen = Automation['notify']

export const automationsKey = ['automations'] as const

/** What the last (or current) run did, in the words shown in the list. */
export const STATUS_LABELS: Record<string, string> = {
  running: 'Running',
  waiting: 'Needs your approval',
  paused: 'Paused',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Stopped',
  retrying: 'Failed, will retry',
  missed: 'Missed (the app was off)',
  skipped: 'Skipped (still running)',
}

export function useAutomations() {
  return useQuery({
    queryKey: automationsKey,
    queryFn: async () => unwrap(await api.GET('/api/automations')),
  })
}

/** The last runs of one automation, newest first. */
export function useAutomationRuns(id: string) {
  return useQuery({
    queryKey: [...runsKey, 'automation', id],
    queryFn: async () =>
      unwrap(await api.GET('/api/runs', { params: { query: { automation_id: id, kind: 'all', limit: 20 } } })),
  })
}

export interface SchedulePreview {
  /** The schedule in words, e.g. "At 08:00 every day". */
  text: string | null
  nextRuns: string[]
  /** Why the schedule cannot be used, if so. */
  problem: string | null
  /** True once the server has confirmed the schedule and it has a next run. */
  valid: boolean
}

/** The reason the server gave for refusing a schedule, without the technical prefix. */
function problemOf(error: unknown): string {
  if (error instanceof ApiError && Array.isArray(error.details)) {
    const first = (error.details as { msg?: string }[])[0]?.msg
    if (first) return first.replace(/^Value error, /, '')
  }
  return error instanceof Error ? error.message : 'This schedule cannot be used.'
}

/** Asks the server what a schedule means: in words, and when it runs next. */
export function useSchedulePreview(schedule: Schedule): SchedulePreview {
  const query = useQuery({
    queryKey: [...automationsKey, 'preview', schedule],
    queryFn: async () => unwrap(await api.POST('/api/automations/schedule-preview', { body: { schedule } })),
    retry: false,
    // Keep showing the previous answer while the next one loads (no flicker while typing).
    placeholderData: (previous) => previous,
  })
  const nextRuns = query.data?.next_runs ?? []
  return {
    text: query.data?.text ?? null,
    nextRuns,
    problem: query.isError ? problemOf(query.error) : null,
    valid: query.isSuccess && !query.isPlaceholderData && nextRuns.length > 0,
  }
}

function useRefresh() {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: automationsKey })
    void qc.invalidateQueries({ queryKey: runsKey })
    void qc.invalidateQueries({ queryKey: runsSummaryKey })
  }
}

export function useSaveAutomation() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async (v: { id?: string; body: AutomationInput }) =>
      v.id
        ? unwrap(await api.PATCH('/api/automations/{automation_id}', { params: { path: { automation_id: v.id } }, body: v.body }))
        : unwrap(await api.POST('/api/automations', { body: v.body })),
    onSuccess: refresh,
  })
}

export function useSetAutomationEnabled() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async (v: { id: string; enabled: boolean }) =>
      unwrap(
        await api.PATCH('/api/automations/{automation_id}', {
          params: { path: { automation_id: v.id } },
          body: { enabled: v.enabled },
        }),
      ),
    onSettled: refresh,
  })
}

export function useDeleteAutomation() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.DELETE('/api/automations/{automation_id}', { params: { path: { automation_id: id } } })),
    onSuccess: refresh,
  })
}

/** Start a run right now, whatever the schedule says. */
export function useRunAutomation() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.POST('/api/automations/{automation_id}/run', { params: { path: { automation_id: id } } })),
    onSettled: refresh,
  })
}
