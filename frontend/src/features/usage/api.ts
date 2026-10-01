import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { api, type Schemas, unwrap } from '@/api/client'
import type { Range } from './ranges'

export type UsageSummary = Schemas['UsageSummary']
export type UsageGroup = Schemas['UsageGroup']
export type UsageTotals = Schemas['UsageTotals']
export type UsageRecord = Schemas['UsageRecordOut']
export type GroupBy = 'day' | 'model' | 'provider' | 'kind' | 'profile' | 'automation'

const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const period = (range: Range) => ({
  ...(range.start ? { start: range.start } : {}),
  ...(range.end ? { end: range.end } : {}),
})

/** Totals for a period, and the same numbers split by day, model, kind of work, … */
export function useUsageSummary(range: Range, groupBy: GroupBy) {
  return useQuery({
    queryKey: ['usage', 'summary', range.start, range.end, groupBy],
    placeholderData: (previous) => previous,
    queryFn: async () =>
      unwrap(
        await api.GET('/api/usage/summary', {
          params: { query: { ...period(range), group_by: groupBy, tz: browserTimeZone() } },
        }),
      ),
  })
}

const PAGE = 30

/** The single model calls of a period, newest first, loaded page by page. */
export function useUsageRecords(range: Range) {
  return useInfiniteQuery({
    queryKey: ['usage', 'records', range.start, range.end],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET('/api/usage/records', {
          params: { query: { ...period(range), limit: PAGE, ...(pageParam ? { before: pageParam } : {}) } },
        }),
      ),
    getNextPageParam: (last) => (last.length === PAGE ? last[last.length - 1].ts : null),
  })
}
