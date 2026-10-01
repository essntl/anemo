import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas, unwrap } from '@/api/client'
import { timelineKey } from '@/features/agents/api'

export type Run = Schemas['RunOut']
export type RunListItem = Schemas['RunListItem']
export type RunDetail = Schemas['RunDetail']
export type PlanStep = Schemas['PlanStepIn']

export type RunStatusFilter = 'all' | 'active' | 'waiting' | 'completed' | 'failed' | 'cancelled'
export type RunKindFilter = 'agent' | 'chat' | 'all'

export const runsKey = ['runs'] as const
export const runKey = (id: string) => ['run', id] as const
export const runsSummaryKey = ['runs-summary'] as const

const PAGE = 30

/** Run history, newest first, loaded page by page. */
export function useRuns(filters: { status: RunStatusFilter; kind: RunKindFilter; q: string }) {
  return useInfiniteQuery({
    queryKey: [...runsKey, filters],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET('/api/runs', {
          params: {
            query: {
              status: filters.status,
              kind: filters.kind,
              limit: PAGE,
              ...(filters.q ? { q: filters.q } : {}),
              ...(pageParam ? { before: pageParam } : {}),
            },
          },
        }),
      ),
    getNextPageParam: (last) => (last.length === PAGE ? last[last.length - 1].created_at : null),
  })
}

const FINISHED = ['completed', 'failed', 'cancelled']

/** `pollWhileActive`: fetch again every 2 s until the run has finished. */
export function useRun(id: string | null, options: { pollWhileActive?: boolean } = {}) {
  return useQuery({
    queryKey: runKey(id ?? 'none'),
    enabled: Boolean(id),
    refetchInterval: (query) =>
      options.pollWhileActive && !FINISHED.includes(query.state.data?.status ?? '') ? 2000 : false,
    queryFn: async () => unwrap(await api.GET('/api/runs/{run_id}', { params: { path: { run_id: id! } } })),
  })
}

/** Agent runs that are working or need attention (sidebar badge). */
export function useRunsSummary() {
  return useQuery({
    queryKey: runsSummaryKey,
    queryFn: async () => unwrap(await api.GET('/api/runs-summary')),
  })
}

function useInvalidateRun() {
  const qc = useQueryClient()
  return (run: Run) => {
    void qc.invalidateQueries({ queryKey: runKey(run.id) })
    void qc.invalidateQueries({ queryKey: timelineKey(run.id) })
    void qc.invalidateQueries({ queryKey: runsKey })
    void qc.invalidateQueries({ queryKey: runsSummaryKey })
    if (run.conversation_id) void qc.invalidateQueries({ queryKey: ['conversation', run.conversation_id] })
  }
}

export function usePauseRun() {
  const done = useInvalidateRun()
  return useMutation({
    mutationFn: async (runId: string) =>
      unwrap(await api.POST('/api/runs/{run_id}/pause', { params: { path: { run_id: runId } } })),
    onSuccess: done,
  })
}

export function useResumeRun() {
  const done = useInvalidateRun()
  return useMutation({
    mutationFn: async (v: { runId: string; message?: string }) =>
      unwrap(
        await api.POST('/api/runs/{run_id}/resume', {
          params: { path: { run_id: v.runId } },
          body: { message: v.message ?? null },
        }),
      ),
    onSuccess: done,
  })
}

export function useEditPlan() {
  const done = useInvalidateRun()
  return useMutation({
    mutationFn: async (v: { runId: string; steps: PlanStep[] }) =>
      unwrap(
        await api.PUT('/api/runs/{run_id}/plan', { params: { path: { run_id: v.runId } }, body: { steps: v.steps } }),
      ),
    onSuccess: done,
  })
}

export const toolOutputUrl = (runId: string, callId: string) => `/api/runs/${runId}/outputs/${callId}`
