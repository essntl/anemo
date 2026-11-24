import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, type Schemas, unwrap } from '@/api/client'
import { withReauth } from '@/features/auth/reauthStore'
import { mcpKey } from '@/features/mcp/api'
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

/** How a status looks in the list. */
export const STATUS_TONES: Record<string, 'neutral' | 'accent' | 'success' | 'warning' | 'error'> = {
  running: 'accent',
  waiting: 'warning',
  paused: 'warning',
  completed: 'success',
  failed: 'error',
  retrying: 'warning',
  missed: 'warning',
}

export function useAutomations() {
  return useQuery({
    queryKey: automationsKey,
    queryFn: async () => unwrap(await api.GET('/api/automations')),
  })
}

/**
 * The run log of one automation, newest first. Every status change of a run (it starts,
 * waits for you, goes on after an approval, ends) is a live "run.status" event, which
 * refetches everything under `runsKey`. `version` (the card's state, kept current by
 * "automations.changed") also refetches it when a run is queued or skipped.
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
 *  of the connected MCP servers. Under the MCP key: fetched again when a server or its
 *  tools change ("mcp.changed"), not with every change of an automation. */
export const automationToolsKey = [...mcpKey, 'automation-tools'] as const

export function useToolCatalog() {
  return useQuery({
    queryKey: automationToolsKey,
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

// -- scripts (docs/specs/08-automation-scripts.md) ------------------------------------

/** A script's approved version, the one waiting for review, its owner and secrets. */
export type Script = Schemas['ScriptOut']
export type ScriptVersion = Schemas['ScriptVersionOut']
export type ScriptCode = Schemas['ScriptCode']
export type ScriptCreate = Schemas['ScriptCreateIn']

/** Change some settings of a script (name, description, schedule, what to do when a call
 *  needs approval, notifications, limits). Its code goes through useSaveScriptCode. */
export function usePatchAutomation() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async (v: { id: string; body: Schemas['AutomationPatch'] }) =>
      unwrap(await api.PATCH('/api/automations/{automation_id}', { params: { path: { automation_id: v.id } }, body: v.body })),
    onSuccess: refresh,
  })
}

export const scriptKey = (id: string) => [...automationsKey, 'script', id] as const

/** `id` null: nothing to load (a new script). `version`: refetch when this changes. */
export function useScript(id: string | null, version = '') {
  return useQuery({
    queryKey: [...scriptKey(id ?? ''), version],
    enabled: id !== null,
    placeholderData: keepPreviousData,
    queryFn: async () =>
      unwrap(await api.GET('/api/automations/{automation_id}/script', { params: { path: { automation_id: id ?? '' } } })),
  })
}

/** A new script written in the app (approved at once; needs the password). */
export function useCreateScript() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: (body: ScriptCreate) =>
      withReauth(async () => unwrap(await api.POST('/api/automations/scripts', { body }))),
    onSuccess: refresh,
  })
}

/** Save new code from the app (approved at once; needs the password). */
export function useSaveScriptCode() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: (v: { id: string; body: ScriptCode }) =>
      withReauth(async () =>
        unwrap(await api.PUT('/api/automations/{automation_id}/script', { params: { path: { automation_id: v.id } }, body: v.body })),
      ),
    onSuccess: refresh,
  })
}

/** Approve the version the user looked at (by its hash; needs the password). */
export function useApproveScript() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: (v: { id: string; hash: string; enable: boolean }) =>
      withReauth(async () =>
        unwrap(
          await api.POST('/api/automations/{automation_id}/script/approve', {
            params: { path: { automation_id: v.id } },
            body: { hash: v.hash, enable: v.enable },
          }),
        ),
      ),
    onSuccess: refresh,
  })
}

export function useDiscardScriptChange() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.DELETE('/api/automations/{automation_id}/script/pending', { params: { path: { automation_id: id } } })),
    onSuccess: refresh,
  })
}

/** Set (value) or clear (null) one of a script's secrets. Setting needs the password. */
export function useScriptSecret() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { id: string; name: string; value: string | null }) => {
      const params = { params: { path: { automation_id: v.id, name: v.name } } }
      return v.value === null
        ? (async () => unwrap(await api.DELETE('/api/automations/{automation_id}/script/secrets/{name}', params)))()
        : withReauth(async () =>
            unwrap(await api.PUT('/api/automations/{automation_id}/script/secrets/{name}', { ...params, body: { value: v.value ?? '' } })),
          )
    },
    onSuccess: (_, v) => void qc.invalidateQueries({ queryKey: scriptKey(v.id) }),
  })
}
