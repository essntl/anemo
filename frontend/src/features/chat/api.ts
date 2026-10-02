import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas, unwrap } from '@/api/client'

export type Conversation = Schemas['ConversationOut']
export type ChatMessage = Schemas['MessageOut']
export type Turn = Schemas['TurnOut']

export const conversationsKey = ['conversations'] as const
export const conversationKey = (id: string) => ['conversation', id] as const
export const messagesKey = (id: string) => ['messages', id] as const

/** What a list of chats can be narrowed down by (all optional). */
export interface ChatFilters {
  projectId?: string | null
  tag?: string
  favorite?: boolean
  archived?: boolean
  sort?: 'recent' | 'created' | 'oldest' | 'title'
  /** Last active at or after / before this instant (ISO). */
  activeAfter?: string
  activeBefore?: string
  limit?: number
  offset?: number
}

function listQuery(q: string, f: ChatFilters) {
  return {
    ...(q ? { q } : {}),
    ...(f.projectId ? { project_id: f.projectId } : {}),
    ...(f.tag ? { tag: f.tag } : {}),
    ...(f.favorite ? { favorite: true } : {}),
    ...(f.archived ? { archived: true } : {}),
    ...(f.sort ? { sort: f.sort } : {}),
    ...(f.activeAfter ? { active_after: f.activeAfter } : {}),
    ...(f.activeBefore ? { active_before: f.activeBefore } : {}),
    ...(f.limit ? { limit: f.limit } : {}),
    ...(f.offset ? { offset: f.offset } : {}),
  }
}

/** Chats matching a search text and filters. `enabled: false` waits (e.g. a closed picker). */
export function useConversations(q: string, filters: ChatFilters = {}, enabled = true) {
  const query = listQuery(q, filters)
  return useQuery({
    queryKey: [...conversationsKey, query],
    enabled,
    queryFn: async () => unwrap(await api.GET('/api/conversations', { params: { query } })),
  })
}

/** Every tag used on a chat, with how many chats have it. */
export function useChatTags() {
  return useQuery({
    queryKey: [...conversationsKey, 'tags'],
    queryFn: async () => unwrap(await api.GET('/api/conversations/tags')),
  })
}

export function useConversation(id: string) {
  return useQuery({
    queryKey: conversationKey(id),
    queryFn: async () =>
      unwrap(await api.GET('/api/conversations/{conversation_id}', { params: { path: { conversation_id: id } } })),
  })
}

export function useMessages(id: string) {
  return useQuery({
    queryKey: messagesKey(id),
    queryFn: async () =>
      unwrap(
        await api.GET('/api/conversations/{conversation_id}/messages', { params: { path: { conversation_id: id } } }),
      ),
  })
}

/** A new chat; in a project it starts with the project's default model and agent profile. */
export async function createConversation(modelId: string | null, projectId: string | null = null): Promise<Conversation> {
  return unwrap(await api.POST('/api/conversations', { body: { model_id: modelId, project_id: projectId } }))
}

/** Puts the new messages and the active run into the cache so the UI updates at once. */
function useApplyTurn() {
  const qc = useQueryClient()
  return (conversationId: string, turn: Turn) => {
    qc.setQueryData<ChatMessage[]>(messagesKey(conversationId), (old = []) => {
      const withoutReplaced = old.filter((m) => m.id !== turn.assistant_message.id)
      return [...withoutReplaced, ...(turn.user_message ? [turn.user_message] : []), turn.assistant_message]
    })
    qc.setQueryData<Conversation>(conversationKey(conversationId), (old) =>
      old ? { ...old, active_run_id: turn.run_id } : old,
    )
    void qc.invalidateQueries({ queryKey: conversationsKey })
  }
}

export function useSendTurn() {
  const apply = useApplyTurn()
  return useMutation({
    mutationFn: async (v: {
      conversationId: string
      text: string
      modelId: string | null
      attachmentIds?: string[]
      /** Other chats given to the model as context for this message. */
      referenceIds?: string[]
      mode?: 'chat' | 'agent'
      profileId?: string | null
    }) =>
      unwrap(
        await api.POST('/api/conversations/{conversation_id}/turns', {
          params: { path: { conversation_id: v.conversationId } },
          body: {
            text: v.text,
            model_id: v.modelId,
            attachment_ids: v.attachmentIds ?? [],
            reference_ids: v.referenceIds ?? [],
            mode: v.mode ?? 'chat',
            profile_id: v.profileId ?? null,
          },
        }),
      ),
    onSuccess: (turn, v) => apply(v.conversationId, turn),
  })
}

export function useRegenerate() {
  const apply = useApplyTurn()
  return useMutation({
    mutationFn: async (v: { conversationId: string; modelId: string | null }) =>
      unwrap(
        await api.POST('/api/conversations/{conversation_id}/regenerate', {
          params: { path: { conversation_id: v.conversationId }, query: v.modelId ? { model_id: v.modelId } : {} },
        }),
      ),
    onSuccess: (turn, v) => apply(v.conversationId, turn),
  })
}

export function useCancelRun() {
  return useMutation({
    mutationFn: async (runId: string) =>
      unwrap(await api.POST('/api/runs/{run_id}/cancel', { params: { path: { run_id: runId } } })),
  })
}

export function useUpdateConversation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { id: string; body: Schemas['ConversationPatch'] }) =>
      unwrap(
        await api.PATCH('/api/conversations/{conversation_id}', {
          params: { path: { conversation_id: v.id } },
          body: v.body,
        }),
      ),
    onSuccess: (conv) => {
      qc.setQueryData(conversationKey(conv.id), conv)
      void qc.invalidateQueries({ queryKey: conversationsKey })
    },
  })
}

export function useDeleteConversation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.DELETE('/api/conversations/{conversation_id}', { params: { path: { conversation_id: id } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: conversationsKey }),
  })
}

/** Change the last message you sent and have it answered again. */
export function useEditLast() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { conversationId: string; text: string; modelId: string | null }) =>
      unwrap(
        await api.POST('/api/conversations/{conversation_id}/edit-last', {
          params: { path: { conversation_id: v.conversationId } },
          body: { text: v.text, model_id: v.modelId },
        }),
      ),
    onSuccess: (turn, v) => {
      // Both messages already exist: swap in their new versions.
      qc.setQueryData<ChatMessage[]>(messagesKey(v.conversationId), (old = []) =>
        old.map((m) => (m.id === turn.user_message?.id ? turn.user_message : m.id === turn.assistant_message.id ? turn.assistant_message : m)),
      )
      qc.setQueryData<Conversation>(conversationKey(v.conversationId), (old) =>
        old ? { ...old, active_run_id: turn.run_id } : old,
      )
      void qc.invalidateQueries({ queryKey: conversationsKey })
    },
  })
}

/** A new chat that starts as a copy of this one up to a message. */
export function useBranch() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { conversationId: string; uptoSeq: number }) =>
      unwrap(
        await api.POST('/api/conversations/{conversation_id}/branch', {
          params: { path: { conversation_id: v.conversationId } },
          body: { upto_seq: v.uptoSeq },
        }),
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: conversationsKey }),
  })
}

export type BulkAction = Schemas['ChatBulkIn']['action']

/** One change for several chats at once (archive, favorite, tag, move, delete). */
export function useBulkChats() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { ids: string[]; action: BulkAction; projectId?: string | null; tag?: string }) =>
      unwrap(
        await api.POST('/api/conversations/bulk', {
          body: { ids: v.ids, action: v.action, project_id: v.projectId ?? null, tag: v.tag ?? null },
        }),
      ),
    onSuccess: (_result, v) => {
      void qc.invalidateQueries({ queryKey: conversationsKey })
      void qc.invalidateQueries({ queryKey: ['projects'] })
      for (const id of v.ids) void qc.invalidateQueries({ queryKey: conversationKey(id) })
    },
  })
}

/** Save the chat as a document in the workspace (in its project's folder, if any). */
export function useSaveAsDocument() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (conversationId: string) =>
      unwrap(
        await api.POST('/api/conversations/{conversation_id}/save-document', {
          params: { path: { conversation_id: conversationId } },
        }),
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['documents'] }),
  })
}
