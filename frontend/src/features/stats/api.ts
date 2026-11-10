import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api, type Schemas, unwrap } from '@/api/client'

export type Stats = Schemas['StatsOut']
export type DayValue = Schemas['DayValue']

/**
 * Pre-aggregated stats for local days `from`..`to` ("YYYY-MM-DD", both included): of
 * everything, of one project (`projectId`) or of what is in no project (`noProject`).
 */
export function useStats(from: string, to: string, projectId?: string | null, noProject = false) {
  return useQuery({
    queryKey: ['stats', from, to, projectId ?? null, noProject],
    placeholderData: keepPreviousData,
    queryFn: async () =>
      unwrap(await api.GET('/api/stats', { params: { query: { from, to, ...(projectId ? { project_id: projectId } : noProject ? { no_project: true } : {}) } } })),
  })
}
