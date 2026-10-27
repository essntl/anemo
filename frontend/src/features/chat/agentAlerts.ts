/**
 * Agent news for the Dynamic Island: an agent run finished (or failed), or one is
 * waiting for approval. Only runs the user started in a chat (not plain chat answers,
 * sub-agents or automations, which notify through Notifications), and not about the
 * chat that is open and visible right now.
 */
import type { QueryClient } from '@tanstack/react-query'
import { islandAlert } from '@/features/island/alerts'
import { type Conversation, conversationKey, conversationsKey } from './api'

export interface RunStatusEvent {
  run_id?: string
  status?: string
  conversation_id?: string | null
  kind?: string
  subagent?: boolean
  automation?: boolean
}

function title(qc: QueryClient, id: string): string | undefined {
  const one = qc.getQueryData<Conversation>(conversationKey(id))
  if (one?.title) return one.title
  for (const [, data] of qc.getQueriesData<unknown>({ queryKey: conversationsKey })) {
    const pages = (data as { pages?: { items?: Conversation[] }[] } | undefined)?.pages
    const lists = pages ? pages.map((p) => p.items ?? []) : Array.isArray(data) ? [data as Conversation[]] : []
    for (const list of lists) {
      const hit = list.find((c) => c.id === id)
      if (hit) return hit.title
    }
  }
  return undefined
}

function lookingAt(conversationId: string): boolean {
  return document.visibilityState === 'visible' && window.location.pathname === `/c/${conversationId}`
}

export function alertRunStatus(qc: QueryClient, e: RunStatusEvent): void {
  if (e.kind !== 'agent' || e.subagent || e.automation || !e.conversation_id) return
  if (e.status !== 'completed' && e.status !== 'failed') return
  if (lookingAt(e.conversation_id)) return
  const failed = e.status === 'failed'
  islandAlert({
    title: failed ? 'The agent stopped with an error' : 'The agent finished',
    body: title(qc, e.conversation_id),
    icon: failed ? 'warning' : 'bot',
    tone: failed ? 'error' : 'success',
    duration: 6000,
    link: `/c/${e.conversation_id}`,
  })
}

export function alertApproval(qc: QueryClient, e: { conversation_id?: string | null }): void {
  if (!e.conversation_id || lookingAt(e.conversation_id)) return
  islandAlert({
    title: 'Approval needed',
    body: title(qc, e.conversation_id) ?? 'An agent is waiting for you',
    icon: 'approval',
    tone: 'warning',
    duration: 8000,
    link: `/c/${e.conversation_id}`,
  })
}
