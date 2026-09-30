import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas, unwrap } from '@/api/client'

export type Conversation = Schemas['ConversationOut']
export type ChatMessage = Schemas['MessageOut']
export type Turn = Schemas['TurnOut']

export const conversationsKey = ['conversations'] as const
export const conversationKey = (id: string) => ['conversation', id] as const
export const messagesKey = (id: string) => ['messages', id] as const

export function useConversations(q: string) {
  return useQuery({
    queryKey: [...conversationsKey, q],
    queryFn: async () =>
      unwrap(await api.GET('/api/conversations', { params: { query: q ? { q } : {} } })),
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

export async function createConversation(modelId: string | null): Promise<Conversation> {
  return unwrap(await api.POST('/api/conversations', { body: { model_id: modelId } }))
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
    mutationFn: async (v: { conversationId: string; text: string; modelId: string | null }) =>
      unwrap(
        await api.POST('/api/conversations/{conversation_id}/turns', {
          params: { path: { conversation_id: v.conversationId } },
          body: { text: v.text, model_id: v.modelId },
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
