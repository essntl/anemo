import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas, unwrap } from '@/api/client'
import { settingsKey } from '@/features/settings/api'

export type Memory = Schemas['MemoryOut']
export type MemoryKind = Memory['kind']
export type MemoryStatus = Memory['status']
export type MemorySettings = Required<Schemas['MemorySettings']>

export const memoriesKey = ['memories'] as const
export const memorySummaryKey = ['memories', 'summary'] as const

export const KIND_LABELS: Record<MemoryKind, string> = {
  preference: 'Preference',
  fact: 'Fact',
  project: 'Project',
  instruction: 'Instruction',
}

export function useMemories(status: MemoryStatus, q: string) {
  return useQuery({
    queryKey: [...memoriesKey, 'list', status, q],
    queryFn: async () =>
      unwrap(await api.GET('/api/memories', { params: { query: { status, ...(q ? { q } : {}) } } })),
  })
}

/** Counts, and whether meaning-based search is available (sidebar badge, pages). */
export function useMemorySummary() {
  return useQuery({
    queryKey: memorySummaryKey,
    queryFn: async () => unwrap(await api.GET('/api/memories/summary')),
  })
}

function useInvalidate() {
  const qc = useQueryClient()
  return () => void qc.invalidateQueries({ queryKey: memoriesKey })
}

export function useCreateMemory() {
  const done = useInvalidate()
  return useMutation({
    mutationFn: async (body: Schemas['MemoryIn']) => unwrap(await api.POST('/api/memories', { body })),
    onSuccess: done,
  })
}

export function useUpdateMemory() {
  const done = useInvalidate()
  return useMutation({
    mutationFn: async (v: { id: string; body: Schemas['MemoryPatch'] }) =>
      unwrap(await api.PATCH('/api/memories/{memory_id}', { params: { path: { memory_id: v.id } }, body: v.body })),
    onSuccess: done,
  })
}

export async function deleteMemory(id: string): Promise<void> {
  unwrap(await api.DELETE('/api/memories/{memory_id}', { params: { path: { memory_id: id } } }))
}

export function useDeleteMemory() {
  const done = useInvalidate()
  return useMutation({ mutationFn: deleteMemory, onSuccess: done })
}

export function useApproveMemory() {
  const done = useInvalidate()
  return useMutation({
    mutationFn: async (v: { id: string; content?: string }) =>
      unwrap(
        await api.POST('/api/memories/{memory_id}/approve', {
          params: { path: { memory_id: v.id } },
          body: { content: v.content ?? null },
        }),
      ),
    onSuccess: done,
  })
}

export function useHandleSuggestions() {
  const done = useInvalidate()
  return useMutation({
    mutationFn: async (action: 'approve_all' | 'dismiss_all') =>
      unwrap(await api.POST('/api/memories/suggestions', { body: { action } })),
    onSuccess: done,
  })
}

export function useReindexMemories() {
  return useMutation({ mutationFn: async () => unwrap(await api.POST('/api/memories/reindex')) })
}

export function useSaveMemorySettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (body: MemorySettings) => unwrap(await api.PUT('/api/settings/memory', { body })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: settingsKey }),
  })
}

export const memoryExportUrl = '/api/memories/export'
