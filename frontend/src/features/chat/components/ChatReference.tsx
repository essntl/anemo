import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { MessagesSquare, X } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Dialog } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { formatWhen } from '@/lib/format'
import { useConversations } from '../api'

/** Another chat attached to a message as context for the model. */
export interface ChatRef {
  id: string
  title: string
}

/** How many chats one message can refer to (the server's limit). */
export const MAX_REFERENCES = 5

/**
 * A referenced chat as a small chip: in the composer (with a remove button) and on
 * a sent message (a link to that chat).
 */
export function ReferenceChip({ chat, onRemove, link }: { chat: ChatRef; onRemove?: () => void; link?: boolean }) {
  const body = (
    <>
      <MessagesSquare className="h-4 w-4 shrink-0 text-muted" />
      <span className="min-w-0 truncate text-[12.5px] font-medium">{chat.title || 'Chat'}</span>
    </>
  )
  const box = 'group relative flex h-9 max-w-56 items-center gap-2 rounded-xl border border-border bg-surface-2 px-3'
  if (link) {
    return (
      <Link to={`/c/${chat.id}`} title={`Referenced chat: ${chat.title}`} className={`${box} hover:bg-surface-hover`}>
        {body}
      </Link>
    )
  }
  return (
    <div title={`Referenced chat: ${chat.title}`} className={box}>
      {body}
      {onRemove && (
        <button type="button" aria-label={`Remove reference to ${chat.title}`} onClick={onRemove}
          className="-mr-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-hover hover:text-text">
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}

/**
 * Pick a chat to give the model as context. The model receives that chat's text
 * (or a summary, when it is long) along with your message.
 */
export function ChatPickerDialog({ exclude, onPick, onClose }: {
  /** Chats that cannot be picked: the current one and those already chosen. */
  exclude: string[]
  onPick: (chat: ChatRef) => void
  onClose: () => void
}) {
  const [text, setText] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => {
    const t = window.setTimeout(() => setQ(text.trim()), 250)
    return () => window.clearTimeout(t)
  }, [text])
  const chats = useConversations(q, { limit: 30 })
  const shown = (chats.data ?? []).filter((c) => !exclude.includes(c.id))

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Reference a chat"
      description="The assistant gets that chat as background for your message: in full if it is short, as a summary if it is long."
      className="md:w-[min(92vw,520px)]"
    >
      <Input value={text} autoFocus placeholder="Search your chats…" aria-label="Search your chats" onChange={(e) => setText(e.target.value)} />
      <div className="mt-3 max-h-[45vh] overflow-y-auto rounded-control border border-border">
        {chats.isPending && <p className="p-4 text-[13px] text-muted">Loading…</p>}
        {chats.isError && <p className="p-4 text-[13px] text-error">{errorMessage(chats.error)}</p>}
        {chats.data && shown.length === 0 && <p className="p-4 text-[13px] text-muted">No other chats match.</p>}
        {shown.map((c) => (
          <button key={c.id} type="button" onClick={() => { onPick({ id: c.id, title: c.title }); onClose() }}
            className="flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left last:border-0 hover:bg-surface-hover">
            <MessagesSquare className="h-4 w-4 shrink-0 text-muted" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-medium">{c.title}</span>
              <span className="block truncate text-[11.5px] text-muted">{c.snippet ?? formatWhen(c.last_message_at)}</span>
            </span>
          </button>
        ))}
      </div>
    </Dialog>
  )
}
