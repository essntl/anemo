import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas, unwrap } from '@/api/client'

export type Updates = Schemas['UpdatesOut']
export const updatesKey = ['updates'] as const

/** The update notice: what main has that this build doesn't, and what's new. */
export function useUpdates(options: { staleTime?: number } = {}) {
  return useQuery({
    queryKey: updatesKey,
    queryFn: async () => unwrap(await api.GET('/api/updates')),
    staleTime: options.staleTime ?? 60 * 60_000, // the server checks about once a day
  })
}

function useUpdatesAction(path: '/api/updates/check' | '/api/updates/dismiss' | '/api/updates/whats-new/dismiss') {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => unwrap(await api.POST(path)),
    onSuccess: (data) => qc.setQueryData(updatesKey, data),
  })
}

export const useCheckUpdates = () => useUpdatesAction('/api/updates/check')
export const useDismissUpdate = () => useUpdatesAction('/api/updates/dismiss')
export const useDismissWhatsNew = () => useUpdatesAction('/api/updates/whats-new/dismiss')

/** "a1b2c3d" for a full commit id. */
export const shortCommit = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : '')
