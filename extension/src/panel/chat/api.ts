/** Chat data from Anemo: the same endpoints and query keys as Anemo's own chat. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { unwrap, type Schemas } from '@/shared/api'
import { pageForApi } from '@/shared/learning'
import type { PageContext } from '@/shared/pageContext'
import { useSession } from '../state/useSession'

export type Conversation = Schemas['ConversationOut']
export type ChatMessage = Schemas['MessageOut']
export type Timeline = Schemas['TimelineOut']
export type ToolCall = Schemas['ToolCallOut']
export type Approval = Schemas['ApprovalOut']
export type Mode = 'chat' | 'agent'

export const conversationsKey = ['conversations'] as const
export const conversationKey = (id: string) => ['conversation', id] as const
export const messagesKey = (id: string) => ['messages', id] as const
export const timelineKey = (runId: string) => ['timeline', runId] as const

export function useConversations(q: string, archived = false) {
  const { api } = useSession()
  return useQuery({
    queryKey: [...conversationsKey, q, archived],
    queryFn: async () => unwrap(await api.GET('/api/conversations', { params: { query: { limit: 80, q: q || undefined, archived } } })),
  })
}

export type ConversationPatch = Schemas['ConversationPatch']

/** Rename, favorite, archive or keep (a temporary chat) a chat. */
export function useUpdateConversation() {
  const { api } = useSession()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, body }: { id: string; body: ConversationPatch }) =>
      unwrap(await api.PATCH('/api/conversations/{conversation_id}', { params: { path: { conversation_id: id } }, body })),
    onSuccess: (conv) => {
      qc.setQueryData(conversationKey(conv.id), conv)
      void qc.invalidateQueries({ queryKey: conversationsKey })
    },
  })
}

export function useDeleteConversation() {
  const { api } = useSession()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      unwrap(await api.DELETE('/api/conversations/{conversation_id}', { params: { path: { conversation_id: id } } }))
      return id
    },
    onSuccess: (id) => {
      qc.removeQueries({ queryKey: conversationKey(id) })
      qc.removeQueries({ queryKey: messagesKey(id) })
      void qc.invalidateQueries({ queryKey: conversationsKey })
    },
  })
}

export function useConversation(id: string | null) {
  const { api } = useSession()
  return useQuery({
    queryKey: conversationKey(id ?? ''),
    enabled: Boolean(id),
    queryFn: async () => unwrap(await api.GET('/api/conversations/{conversation_id}', { params: { path: { conversation_id: id! } } })),
  })
}

export function useMessages(id: string | null) {
  const { api } = useSession()
  return useQuery({
    queryKey: messagesKey(id ?? ''),
    enabled: Boolean(id),
    queryFn: async () => unwrap(await api.GET('/api/conversations/{conversation_id}/messages', { params: { path: { conversation_id: id! } } })),
  })
}

export function useAnemoSettings() {
  const { api } = useSession()
  return useQuery({ queryKey: ['settings'], staleTime: 5 * 60_000, queryFn: async () => unwrap(await api.GET('/api/settings')) })
}

export function useModels() {
  const { api } = useSession()
  return useQuery({
    queryKey: ['models'],
    staleTime: 5 * 60_000,
    queryFn: async () => unwrap(await api.GET('/api/models')).filter((m) => m.enabled && m.provider_enabled && m.capabilities.chat !== false),
  })
}

export function useProfiles() {
  const { api } = useSession()
  return useQuery({ queryKey: ['profiles'], staleTime: 5 * 60_000, queryFn: async () => unwrap(await api.GET('/api/profiles')) })
}

export function useTimeline(runId: string | null, version: number) {
  const { api } = useSession()
  return useQuery({
    queryKey: [...timelineKey(runId ?? ''), version],
    enabled: Boolean(runId),
    placeholderData: (prev) => prev,
    queryFn: async () => unwrap(await api.GET('/api/runs/{run_id}/timeline', { params: { path: { run_id: runId! } } })),
  })
}

export interface SendInput {
  conversationId: string | null
  text: string
  mode: Mode
  modelId: string | null
  profileId: string | null
  page?: PageContext | null
  attachmentIds?: string[]
  /** A new chat that is deleted 5 minutes after its last message unless kept. */
  temporary?: boolean
}

/** Sends a message; a new chat is created first. Resolves with the chat and the run. */
export function useSendTurn() {
  const { api } = useSession()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: SendInput) => {
      let conversationId = input.conversationId
      if (!conversationId) {
        const conv = unwrap(await api.POST('/api/conversations', { body: { model_id: input.modelId, temporary: input.temporary ?? false } }))
        conversationId = conv.id
      }
      const turn = unwrap(
        await api.POST('/api/conversations/{conversation_id}/turns', {
          params: { path: { conversation_id: conversationId } },
          body: {
            text: input.text,
            mode: input.mode,
            model_id: input.modelId,
            profile_id: input.mode === 'agent' ? input.profileId : null,
            attachment_ids: input.attachmentIds ?? [],
            reference_ids: [],
            page: input.page ? pageForApi(input.page) : null,
          },
        }),
      )
      return { conversationId, turn }
    },
    onSuccess: ({ conversationId }) => {
      void qc.invalidateQueries({ queryKey: conversationsKey })
      void qc.invalidateQueries({ queryKey: conversationKey(conversationId) })
      void qc.invalidateQueries({ queryKey: messagesKey(conversationId) })
    },
  })
}

export function useCancelRun() {
  const { api } = useSession()
  return useMutation({
    mutationFn: async (runId: string) => unwrap(await api.POST('/api/runs/{run_id}/cancel', { params: { path: { run_id: runId } } })),
  })
}

export interface DecisionInput {
  approvalId: string
  decision: 'approve' | 'deny'
  scope?: 'once' | 'run'
  reason?: string | null
  answer?: string | null
}

export function useDecide() {
  const { api } = useSession()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (d: DecisionInput) =>
      unwrap(
        await api.POST('/api/approvals/{approval_id}', {
          params: { path: { approval_id: d.approvalId } },
          body: { decision: d.decision, scope: d.scope ?? 'once', reason: d.reason ?? null, answer: d.answer ?? null },
        }),
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['timeline'] }),
  })
}
