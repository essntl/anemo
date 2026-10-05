import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { toast } from '@/components/ui/toast'
import { approvalsKey } from '@/features/agents/api'
import { automationsKey } from '@/features/automations/api'
import { mcpKey } from '@/features/mcp/api'
import { notificationsKey } from '@/features/notifications/api'
import { showDesktopNotification } from '@/features/notifications/desktop'
import { conversationKey, conversationsKey, messagesKey } from './api'
import { TERMINAL } from './runStream'

/**
 * One app-wide event stream per tab. Keeps lists fresh when something changes
 * elsewhere (a run finishes in another tab, a title is generated, ...).
 */
export function useAppEvents() {
  const qc = useQueryClient()
  const navigate = useNavigate()
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
    // Chats were deleted elsewhere (temporary chats whose time ran out). Leave one that
    // is open here, and say why.
    source.addEventListener('conversations.changed', ((e: MessageEvent<string>) => {
      const deleted = (JSON.parse(e.data) as { deleted?: string[] }).deleted ?? []
      void qc.invalidateQueries({ queryKey: conversationsKey })
      for (const id of deleted) {
        qc.removeQueries({ queryKey: conversationKey(id) })
        qc.removeQueries({ queryKey: messagesKey(id) })
        if (window.location.pathname === `/c/${id}`) {
          void navigate('/')
          toast({ message: 'The temporary chat was deleted.' })
        }
      }
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
    // An MCP server was checked, or its tools changed.
    source.addEventListener('mcp.changed', () => void qc.invalidateQueries({ queryKey: mcpKey }))
    source.addEventListener('automations.changed', () => void qc.invalidateQueries({ queryKey: automationsKey }))
    // A new notification (a reminder, an automation's result, ...): show it as a
    // desktop notification when the tab is in the background, else as a notice here.
    source.addEventListener('notification', ((e: MessageEvent<string>) => {
      const note = JSON.parse(e.data) as { id: string; title: string; body: string; link: string | null }
      void qc.invalidateQueries({ queryKey: notificationsKey })
      const open = () => void navigate(note.link ?? '/notifications')
      if (showDesktopNotification(note, open)) return
      // About what is on screen already (e.g. the agent's question in the open chat).
      if (note.link && window.location.pathname === note.link) return
      toast({ message: note.title, duration: 10_000, action: { label: 'Open', onClick: open } })
    }) as EventListener)
    source.addEventListener('notifications.changed', () => void qc.invalidateQueries({ queryKey: notificationsKey }))
    return () => source.close()
  }, [qc, navigate])
}
