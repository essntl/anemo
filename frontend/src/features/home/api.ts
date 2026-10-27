import { useQuery } from '@tanstack/react-query'
import { api, type Schemas, unwrap } from '@/api/client'

export type RecentDocument = Schemas['RecentDocument']

/** The last edited documents with their first line; `folder` is a project's folder. */
export function useRecentDocuments(limit: number, folder?: string | null) {
  return useQuery({
    queryKey: ['documents', 'recent', limit, folder ?? null],
    queryFn: async () => unwrap(await api.GET('/api/documents/recent', { params: { query: { limit, ...(folder ? { folder } : {}) } } })),
  })
}

/** One run (an automation's latest), with its final answer. */
export function useRunAnswer(runId: string | null | undefined) {
  return useQuery({
    queryKey: ['runs', 'answer', runId],
    enabled: !!runId,
    queryFn: async () => unwrap(await api.GET('/api/runs/{run_id}', { params: { path: { run_id: runId! } } })),
  })
}
