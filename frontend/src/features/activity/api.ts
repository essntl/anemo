import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas, unwrap } from '@/api/client'

export type ActivityEntry = Schemas['ActivityOut']
export type ActorKind = 'user' | 'assistant' | 'automation' | 'script' | 'plugin' | 'trigger'
export type ObjectType = 'task' | 'event' | 'document' | 'file' | 'project' | 'device'

export const activityKey = ['activity'] as const
const PAGE = 50

export interface ActivityFilters {
  actorKind?: ActorKind
  objectType?: ObjectType
  objectId?: string
  /** ISO time: only entries from then on. */
  since?: string
}

/** The activity log, newest first, loaded page by page. */
export function useActivity(filters: ActivityFilters) {
  return useInfiniteQuery({
    queryKey: [...activityKey, filters],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET('/api/activity', {
          params: {
            query: {
              limit: PAGE,
              ...(filters.actorKind ? { actor_kind: filters.actorKind } : {}),
              ...(filters.objectType ? { object_type: filters.objectType } : {}),
              ...(filters.objectId ? { object_id: filters.objectId } : {}),
              ...(filters.since ? { since: filters.since } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ),
    getNextPageParam: (last) => last.next_cursor ?? null,
  })
}

/** Undo one entry; `force` overwrites what changed since. Everything that shows items is refreshed. */
export function useUndoEntry() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, force = false }: { id: string; force?: boolean }) =>
      unwrap(await api.POST('/api/activity/{entry_id}/undo', { params: { path: { entry_id: id }, query: { force } } })),
    // An undo can change tasks, events, documents, files and projects: they all reload.
    onSettled: () => qc.invalidateQueries(),
  })
}

/** Undo a batch (each entry on its own; the results say which were undone). */
export function useUndoGroup() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ groupId, force = false }: { groupId: string; force?: boolean }) =>
      unwrap(await api.POST('/api/activity/groups/{group_id}/undo', { params: { path: { group_id: groupId }, query: { force } } })),
    onSettled: () => qc.invalidateQueries(),
  })
}

/** The page's address filtered to one item ("History" links from a task, event or document). */
export const historyLink = (objectType: ObjectType, objectId: string) =>
  `/activity?object_type=${objectType}&object_id=${encodeURIComponent(objectId)}`
