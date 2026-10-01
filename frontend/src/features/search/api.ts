import { useQuery } from '@tanstack/react-query'
import { api, type Schemas, unwrap } from '@/api/client'

export type SearchHit = Schemas['SearchHit']
export type SearchGroup = Schemas['SearchGroup']
export type SearchKind = SearchHit['kind']

interface SearchOptions {
  /** Only these kinds; default: everything. */
  kinds?: SearchKind[]
  /** Hits per kind. */
  limit: number
  /**
   * "keyword" matches words and is quick (used while typing). "hybrid" also finds
   * documents and memories by meaning, which calls the embedding model.
   */
  mode: 'keyword' | 'hybrid'
}

/** Search the whole workspace. Nothing is fetched for an empty query. */
export function useSearch(query: string, options: SearchOptions) {
  const q = query.trim()
  return useQuery({
    queryKey: ['search', q, options.kinds ?? 'all', options.limit, options.mode],
    enabled: q.length > 0,
    staleTime: 15_000,
    // Keep showing the previous hits while the next ones load (no flicker while typing).
    placeholderData: (previous) => previous,
    queryFn: async () =>
      unwrap(
        await api.GET('/api/search', {
          params: {
            query: {
              q,
              limit: options.limit,
              mode: options.mode,
              ...(options.kinds ? { kinds: options.kinds.join(',') } : {}),
            },
          },
        }),
      ),
  })
}
