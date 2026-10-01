/**
 * The agent's browser on a page of its own: used when it is popped out into a
 * separate window, and on phones (where there is no room for a side panel).
 */
import { useEffect } from 'react'
import { Link, useParams } from 'react-router'
import { ArrowLeft } from 'lucide-react'
import { DialogHost } from '@/components/ui/DialogHost'
import { useConversation } from '@/features/chat/api'
import { useAppearanceSync } from '@/features/settings/useAppearanceSync'
import { BrowserView } from './BrowserView'

export function BrowserPage() {
  useAppearanceSync() // theme and accent, as in the rest of the app
  const { conversationId = '' } = useParams()
  const conversation = useConversation(conversationId)
  // Opened by the chat's "separate window" button: there is no chat to go back to here.
  const popup = window.opener !== null
  const title = conversation.data?.title
  useEffect(() => {
    if (title) document.title = `Browser · ${title}`
  }, [title])

  return (
    <div className="flex h-full flex-col">
      {!popup && (
        <Link to={`/c/${conversationId}`}
          className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border px-3 text-[14px] text-muted hover:text-text">
          <ArrowLeft className="h-4 w-4" />
          <span className="min-w-0 truncate">Back to {conversation.data?.title ?? 'the chat'}</span>
        </Link>
      )}
      <BrowserView conversationId={conversationId} className="min-h-0 flex-1" />
      <DialogHost />
    </div>
  )
}
