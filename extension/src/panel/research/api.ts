import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { unwrap, type Schemas } from '@/shared/api'
import { addToResearch, type AddMode } from '@/shared/research'
import { activeTab } from '../chat/currentTab'
import { useSession } from '../state/useSession'
import { useStored } from '../state/useStored'

export type Session = Schemas['ResearchSessionOut']
export type SessionDetail = Schemas['ResearchSessionDetail']
export type Source = Schemas['ResearchSourceOut']

export const sessionsKey = ['research', 'sessions'] as const
export const sessionKey = (id: string) => ['research', 'session', id] as const

/** Refetches research data whenever Anemo says it changed (the worker bumps a counter on
 *  each research.changed event). Called once, by the Research view. */
export function useFollowResearchChanges(): void {
  const qc = useQueryClient()
  const version = useStored('session', 'researchVersion').value
  useEffect(() => {
    if (version !== undefined) void qc.invalidateQueries({ queryKey: ['research'] })
  }, [qc, version])
}

export function useSessions() {
  const { api } = useSession()
  return useQuery({ queryKey: sessionsKey, queryFn: async () => unwrap(await api.GET('/api/research/sessions')) })
}

export function useSessionDetail(id: string | null) {
  const { api } = useSession()
  return useQuery({
    queryKey: sessionKey(id ?? ''),
    enabled: Boolean(id),
    queryFn: async () => unwrap(await api.GET('/api/research/sessions/{session_id}', { params: { path: { session_id: id! } } })),
  })
}

export function useResearchMutations(id: string | null) {
  const { api } = useSession()
  const qc = useQueryClient()
  const refresh = () => void qc.invalidateQueries({ queryKey: ['research'] })
  const path = { session_id: id ?? '' }
  return {
    create: useMutation({ mutationFn: async (topic: string) => unwrap(await api.POST('/api/research/sessions', { body: { topic } })), onSuccess: refresh }),
    setStatus: useMutation({ mutationFn: async (status: 'active' | 'paused') => unwrap(await api.PATCH('/api/research/sessions/{session_id}', { params: { path }, body: { status } })), onSuccess: refresh }),
    rename: useMutation({ mutationFn: async (topic: string) => unwrap(await api.PATCH('/api/research/sessions/{session_id}', { params: { path }, body: { topic } })), onSuccess: refresh }),
    updateSource: useMutation({
      mutationFn: async (v: { id: string; note?: string; key?: boolean }) =>
        unwrap(await api.PATCH('/api/research/sources/{source_id}', { params: { path: { source_id: v.id } }, body: { note: v.note ?? null, key: v.key ?? null } })),
      onSuccess: refresh,
    }),
    add: useMutation({
      mutationFn: async (v: { mode: AddMode; note: string }) => {
        const tab = await activeTab()
        if (!tab) throw new Error('No tab is open.')
        return addToResearch(api, id ?? '', tab, v)
      },
      onSuccess: refresh,
    }),
    removeSource: useMutation({ mutationFn: async (sourceId: string) => unwrap(await api.DELETE('/api/research/sources/{source_id}', { params: { path: { source_id: sourceId } } })), onSuccess: refresh }),
    reorder: useMutation({ mutationFn: async (ids: string[]) => unwrap(await api.PUT('/api/research/sessions/{session_id}/order', { params: { path }, body: { source_ids: ids } })), onSuccess: refresh }),
    conversation: useMutation({ mutationFn: async () => unwrap(await api.POST('/api/research/sessions/{session_id}/conversation', { params: { path } })).conversation_id, onSuccess: refresh }),
    end: useMutation({ mutationFn: async (format: 'notes' | 'outline' | 'table') => unwrap(await api.POST('/api/research/sessions/{session_id}/end', { params: { path }, body: { format } })), onSuccess: refresh }),
  }
}
