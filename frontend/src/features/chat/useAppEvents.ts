import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@/components/ui/toast'
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
    // Memories changed (a tool saved one, or background extraction found some).
    source.addEventListener('memory.changed', () => void qc.invalidateQueries({ queryKey: ['memories'] }))
    // A document was saved (here, in another tab, or by an agent).
    source.addEventListener('document.changed', ((e: MessageEvent<string>) => {
      const data = JSON.parse(e.data) as { document_id?: string }
      void qc.invalidateQueries({ queryKey: ['documents'] })
      if (data.document_id) void qc.invalidateQueries({ queryKey: ['document', data.document_id] })
    }) as EventListener)
    // Tasks and calendar changed (another tab, or an agent).
    source.addEventListener('tasks.changed', () => {
      void qc.invalidateQueries({ queryKey: ['tasks'] })
      void qc.invalidateQueries({ queryKey: ['projects'] })
    })
    source.addEventListener('calendar.changed', () => void qc.invalidateQueries({ queryKey: ['calendar'] }))
    // A reminder for an event or task became due.
    source.addEventListener('reminder', ((e: MessageEvent<string>) => {
      const data = JSON.parse(e.data) as { kind: string; title: string; starts_at: string; all_day: boolean }
      const when = new Date(data.starts_at)
      const time = data.all_day
        ? when.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
        : when.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
      toast({ message: `Reminder: ${data.title} (${data.kind === 'task' ? 'due ' : ''}${time})`, duration: 30_000 })
    }) as EventListener)
    return () => source.close()
  }, [qc])
}
