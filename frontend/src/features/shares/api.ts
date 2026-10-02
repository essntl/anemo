import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas, unwrap } from '@/api/client'
import type { ProjectSection } from './links'

export type ShareLink = Schemas['ShareOut']
export type ShareKind = ShareLink['kind']
/** The frozen copy a visitor sees. */
export type Shared = Schemas['SharedOut']

export const sharesKey = ['shares'] as const

/** What is being shared: a chat, a document or a project. */
export interface ShareTarget {
  kind: ShareKind
  id: string
  title: string
}

const FILTER = { chat: 'conversation_id', document: 'document_id', project: 'project_id' } as const

/** The links of one chat, document or project; without a target, every link. */
export function useShares(target?: ShareTarget) {
  const query = target ? { [FILTER[target.kind]]: target.id } : {}
  return useQuery({
    queryKey: [...sharesKey, query],
    queryFn: async () => unwrap(await api.GET('/api/shares', { params: { query } })),
  })
}

export function useCreateShare() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { target: ShareTarget; days: number | null; sections?: ProjectSection[] }) =>
      unwrap(
        await api.POST('/api/shares', {
          body: {
            kind: v.target.kind, target_id: v.target.id, expires_in_days: v.days,
            sections: v.sections ?? [], // only used for a project overview
          },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: sharesKey }),
  })
}

/** Make the copy again from how things are now. The link stays the same. */
export function useRefreshShare() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.POST('/api/shares/{share_id}/refresh', { params: { path: { share_id: id } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: sharesKey }),
  })
}

export function useRevokeShare() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.DELETE('/api/shares/{share_id}', { params: { path: { share_id: id } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: sharesKey }),
  })
}

export function useRevokeAllShares() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => unwrap(await api.DELETE('/api/shares')),
    onSuccess: () => qc.invalidateQueries({ queryKey: sharesKey }),
  })
}

/** The copy behind a link. No login: this is what a visitor's browser asks for. */
export function useShared(token: string) {
  return useQuery({
    queryKey: ['shared', token],
    retry: false,
    queryFn: async () => unwrap(await api.GET('/api/public/shares/{token}', { params: { path: { token } } })),
  })
}
