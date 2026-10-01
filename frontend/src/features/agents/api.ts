import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas, unwrap } from '@/api/client'
import { withReauth } from '@/features/auth/reauthStore'
import { settingsKey } from '@/features/settings/api'

export type Timeline = Schemas['TimelineOut']
export type ToolCallView = Schemas['ToolCallOut']
export type PermissionSettings = Schemas['PermissionSettings']
export type PermissionSummary = Schemas['PermissionSummary']
export type Level = Schemas['LevelOut']['level']
export type FileChangeView = Schemas['FileChangeOut']

export const timelineKey = (runId: string) => ['timeline', runId] as const
export const approvalsKey = ['approvals'] as const
export const permissionSummaryKey = ['permissions', 'summary'] as const

export function useTimeline(runId: string | null) {
  return useQuery({
    queryKey: timelineKey(runId ?? 'none'),
    enabled: Boolean(runId),
    queryFn: async () =>
      unwrap(await api.GET('/api/runs/{run_id}/timeline', { params: { path: { run_id: runId! } } })),
  })
}

export function usePendingApprovals() {
  return useQuery({
    queryKey: approvalsKey,
    queryFn: async () => unwrap(await api.GET('/api/approvals')),
  })
}

export function useDecide(runId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: {
      approvalId: string
      decision: 'approve' | 'deny'
      scope?: 'once' | 'run'
      reason?: string
      /** Plan reviews: the steps as edited by the user. */
      plan?: { title: string; status?: 'pending' | 'in_progress' | 'done' | 'skipped' }[]
    }) =>
      unwrap(
        await api.POST('/api/approvals/{approval_id}', {
          params: { path: { approval_id: v.approvalId } },
          body: {
            decision: v.decision,
            scope: v.scope ?? 'once',
            reason: v.reason ?? null,
            plan: v.plan ? { steps: v.plan.map((s) => ({ title: s.title, status: s.status ?? 'pending' })) } : null,
          },
        }),
      ),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: timelineKey(runId) })
      void qc.invalidateQueries({ queryKey: approvalsKey })
    },
  })
}

/** What an agent run may do: global settings, or those of an agent profile. */
export function usePermissionSummary(profileId: string | null = null) {
  return useQuery({
    queryKey: [...permissionSummaryKey, profileId],
    queryFn: async () =>
      unwrap(
        await api.GET('/api/permissions/summary', {
          params: { query: profileId ? { profile_id: profileId } : {} },
        }),
      ),
  })
}

export function usePermissionCatalog() {
  return useQuery({
    queryKey: ['permissions', 'catalog'],
    staleTime: Infinity,
    queryFn: async () => unwrap(await api.GET('/api/permissions/catalog')),
  })
}

export async function previewPermissions(body: PermissionSettings) {
  return unwrap(await api.POST('/api/permissions/preview', { body }))
}

export function useSavePermissions() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: PermissionSettings) =>
      withReauth(async () => unwrap(await api.PUT('/api/settings/permissions', { body }))),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: settingsKey })
      void qc.invalidateQueries({ queryKey: permissionSummaryKey })
    },
  })
}

export function useRevertChange(runId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { changeId: string; force?: boolean }) =>
      unwrap(
        await api.POST('/api/runs/{run_id}/files/{change_id}/revert', {
          params: { path: { run_id: runId, change_id: v.changeId }, query: { force: v.force ?? false } },
        }),
      ),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: timelineKey(runId) })
      void qc.invalidateQueries({ queryKey: ['files'] })
    },
  })
}
