import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api, type Schemas, unwrap } from '@/api/client'

export type Stats = Schemas['StatsOut']
export type DayValue = Schemas['DayValue']

/** Pre-aggregated stats for local days `from`..`to` ("YYYY-MM-DD", both included). */
export function useStats(from: string, to: string, projectId?: string | null) {
  return useQuery({
    queryKey: ['stats', from, to, projectId ?? null],
    placeholderData: keepPreviousData,
    queryFn: async () =>
      unwrap(await api.GET('/api/stats', { params: { query: { from, to, ...(projectId ? { project_id: projectId } : {}) } } })),
  })
}
