import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas, unwrap } from '@/api/client'

export type TrashedItem = Schemas['TrashedOut']
export type TrashKind = TrashedItem['kind']

export const trashKey = ['trash'] as const

/** Deleted tasks or calendar events (files have their own trash, in Files). */
export function useTrashed(kind: TrashKind, enabled: boolean) {
  return useQuery({
    queryKey: [...trashKey, kind],
    enabled,
    queryFn: async () => unwrap(await api.GET('/api/trash', { params: { query: { kind } } })),
  })
}

/** After a restore, the lists the item goes back into are stale too. */
function useRefresh() {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: trashKey })
    void qc.invalidateQueries({ queryKey: ['tasks'] })
    void qc.invalidateQueries({ queryKey: ['calendar'] })
  }
}

export function useRestoreTrashed() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.POST('/api/trash/{trash_id}/restore', { params: { path: { trash_id: id } } })),
    onSuccess: refresh,
  })
}

export function usePurgeTrashed() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.DELETE('/api/trash/{trash_id}', { params: { path: { trash_id: id } } })),
    onSuccess: refresh,
  })
}
