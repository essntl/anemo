import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas, unwrap } from '@/api/client'

export type SavedView = Schemas['ViewOut']
export type ViewQuery = Schemas['ViewQuery']
export type ViewRow = Schemas['ViewRow']
export type ViewLayout = SavedView['layout']

export const viewsKey = ['views'] as const
export const viewKey = (id: string) => ['views', id] as const
export const viewRowsKey = (id: string) => ['views', id, 'rows'] as const

export function useViews() {
  return useQuery({
    queryKey: viewsKey,
    queryFn: async () => unwrap(await api.GET('/api/views')),
  })
}

export function useView(id: string) {
  return useQuery({
    queryKey: viewKey(id),
    queryFn: async () => unwrap(await api.GET('/api/views/{view_id}', { params: { path: { view_id: id } } })),
  })
}

export function useViewRows(id: string) {
  return useQuery({
    queryKey: viewRowsKey(id),
    queryFn: async () => unwrap(await api.GET('/api/views/{view_id}/rows', { params: { path: { view_id: id } } })),
  })
}

export function useCreateView() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (body: Schemas['ViewIn']) => unwrap(await api.POST('/api/views', { body })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: viewsKey }),
  })
}

export function useUpdateView() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { id: string; body: Schemas['ViewPatch'] }) =>
      unwrap(await api.PATCH('/api/views/{view_id}', { params: { path: { view_id: v.id } }, body: v.body })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: viewsKey }),
  })
}

export function useDeleteView() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => unwrap(await api.DELETE('/api/views/{view_id}', { params: { path: { view_id: id } } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: viewsKey }),
  })
}

/** Changes one property of a row's document (the server rewrites its front matter, with a revision). */
export function useSetRowProperty(viewId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { row: ViewRow; key: string; value: unknown }) =>
      unwrap(
        await api.PUT('/api/documents/{document_id}/properties', {
          params: { path: { document_id: v.row.id } },
          body: { set: { [v.key]: v.value === '' ? null : v.value }, base_hash: null, create_values: false },
        }),
      ),
    onSuccess: (_doc, v) => {
      void qc.invalidateQueries({ queryKey: viewRowsKey(viewId) })
      void qc.invalidateQueries({ queryKey: ['document', v.row.id] })
    },
  })
}
