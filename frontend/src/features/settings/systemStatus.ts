import { useQuery } from '@tanstack/react-query'
import { api, unwrap } from '@/api/client'

/** Settings > Advanced's system status (also the first-run setup's optional parts). */
export function useSystemStatus() {
  return useQuery({
    queryKey: ['system', 'status'],
    queryFn: async () => unwrap(await api.GET('/api/system/status')),
    staleTime: 0, // always fresh when the page is opened
  })
}
