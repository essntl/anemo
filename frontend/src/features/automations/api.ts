import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, type Schemas, unwrap } from '@/api/client'
import { runsKey, runsSummaryKey } from '@/features/runs/api'
import { msg, t } from '@/lib/i18n'
import type { Schedule } from './scheduleForm'

export type Automation = Schemas['AutomationOut']
export type AutomationInput = Required<Schemas['AutomationIn']>
/** What the dialog saves: the state note only when the user changed it (a run may have
 * replaced it while the dialog was open). */
export type AutomationSave = Omit<AutomationInput, 'state_note'> & { state_note?: string | null }
export type OnAsk = Automation['on_ask']
export type NotifyWhen = Automation['notify']
/** One line of an automation's run log: its outcome, what it changed and how long it took. */
export type AutomationRun = Schemas['AutomationRunOut']
export type ChangeCheck = Schemas['ChangeCheck']
/** A tool an automation's runs can be given: a built-in one, or one of a connected MCP server. */
export type ToolInfo = Schemas['AutomationToolOut']

export const automationsKey = ['automations'] as const

/** What the last (or current) run did, in the words shown in the list (show them with `t`). */
export const STATUS_LABELS: Record<string, string> = {
  running: msg('Running'),
  waiting: msg('Needs your approval'),
  paused: msg('Paused'),
  completed: msg('Done'),
  failed: msg('Failed'),
  cancelled: msg('Stopped'),
  retrying: msg('Failed, will retry'),
  missed: msg('Missed (the app was off)'),
  skipped: msg('Skipped (still running)'),
  no_change: msg('Skipped (no change)'),
}

export function useAutomations() {
  return useQuery({
    queryKey: automationsKey,
    queryFn: async () => unwrap(await api.GET('/api/automations')),
  })
}

/**
 * The run log of one automation, newest first. `version` changes when one of its runs
 * starts or ends (the card's state, which the app's live events keep current), so the
 * log is fetched again then: a run's timer stops when it ends.
 */
export function useAutomationRuns(id: string, version = '') {
  return useQuery({
    queryKey: [...runsKey, 'automation', id, version],
    placeholderData: keepPreviousData,
    queryFn: async () =>
      unwrap(await api.GET('/api/automations/{automation_id}/runs', { params: { path: { automation_id: id }, query: { limit: 30 } } })),
  })
}

/** One run of the log, found by its id (a link may point to one older than the log shows). */
export function useAutomationRun(id: string, runId: string | null) {
  return useQuery({
    queryKey: [...runsKey, 'automation', id, 'run', runId],
    enabled: runId !== null,
    queryFn: async () =>
      unwrap(await api.GET('/api/automations/{automation_id}/runs', { params: { path: { automation_id: id }, query: { run_id: runId } } })),
  })
}

/** The tools for an automation's tool list and change check: the built-in ones and those
 *  of the connected MCP servers. */
export function useToolCatalog() {
  return useQuery({
    queryKey: [...automationsKey, 'tools'],
    queryFn: async () => unwrap(await api.GET('/api/automations/tools')),
    staleTime: 5 * 60_000,
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
  return error instanceof Error ? error.message : t('This schedule cannot be used.')
}

/** Asks the server what a schedule means: in words, and when it runs next. */
export function useSchedulePreview(schedule: Schedule, changeCheck = false): SchedulePreview {
  const query = useQuery({
    queryKey: [...automationsKey, 'preview', schedule, changeCheck],
    queryFn: async () =>
      unwrap(await api.POST('/api/automations/schedule-preview', { body: { schedule, change_check: changeCheck } })),
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
    mutationFn: async (v: { id?: string; body: AutomationSave }) =>
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
