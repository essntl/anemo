import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { approvalsKey } from '@/features/agents/api'
import { conversationKey, conversationsKey, messagesKey } from './api'
import { TERMINAL } from './runStream'

/**
 * One app-wide event stream per tab. Keeps lists fresh when something changes
 * elsewhere (a run finishes in another tab, a title is generated, ...).
 */
export function useAppEvents() {
  const qc = useQueryClient()
  useEffect(() => {
    const source = new EventSource('/api/events')
    const refreshConversation = (e: MessageEvent<string>) => {
      const data = JSON.parse(e.data) as { conversation_id?: string | null; status?: string }
      void qc.invalidateQueries({ queryKey: conversationsKey })
      void qc.invalidateQueries({ queryKey: ['runs'] })
      void qc.invalidateQueries({ queryKey: ['runs-summary'] })
      if (!data.conversation_id) return
      void qc.invalidateQueries({ queryKey: conversationKey(data.conversation_id) })
      if (data.status && TERMINAL.includes(data.status)) {
        // A run finished: its final message is now in the database.
        void qc.invalidateQueries({ queryKey: messagesKey(data.conversation_id) })
      }
    }
    source.addEventListener('run.status', refreshConversation as EventListener)
    source.addEventListener('conversation.updated', refreshConversation as EventListener)
    source.addEventListener('approval.requested', ((e: MessageEvent<string>) => {
      void qc.invalidateQueries({ queryKey: approvalsKey })
      refreshConversation(e)
    }) as EventListener)
    return () => source.close()
  }, [qc])
}
