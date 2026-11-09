/**
 * A temporary chat is deleted 5 minutes after its last message unless kept (Anemo does
 * it). The badge shows the time left; clicking it explains and offers to keep the chat.
 */
import { useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { Timer } from 'lucide-react'
import { formatRemaining } from '@/shared/format'
import { Button } from '../ui/Button'
import { useNow } from '../state/useNow'
import { useUpdateConversation, type Conversation } from './api'

export function TemporaryBadge({ conversation }: { conversation: Conversation }) {
  const keep = useUpdateConversation()
  const now = useNow(1000)
  const [open, setOpen] = useState(false)
  const answering = Boolean(conversation.active_run_id)
  const left = conversation.expires_at ? new Date(conversation.expires_at).getTime() - now : 0
  const time = answering || !conversation.expires_at ? '5:00' : formatRemaining(left, 'clock')
  const when = answering || !conversation.expires_at ? 'It is deleted 5 minutes after the answer' : left > 0 ? `It is deleted in ${time} (5 minutes after the last message)` : 'It is being deleted'
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`Temporary chat, ${time} left`}
          className="flex h-6 shrink-0 items-center gap-1 rounded-full border border-dashed border-accent/60 bg-accent-soft/50 px-2 text-[11.5px] font-medium tabular-nums text-accent hover:bg-accent-soft"
        >
          <Timer className="h-3.5 w-3.5" /> {time}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} collisionPadding={10} className="pop z-50 w-64 rounded-card border border-border bg-card p-3.5 text-[13px] shadow-float">
          <p className="flex items-center gap-1.5 font-semibold">
            <Timer className="h-4 w-4 text-accent" /> Temporary chat
          </p>
          <p className="mt-1.5 text-muted">{when} unless you keep it. Nothing is remembered from it.</p>
          {keep.isError && <p className="mt-2 text-error">{(keep.error as Error).message}</p>}
          <Button size="sm" variant="primary" className="mt-3 w-full justify-center" loading={keep.isPending} onClick={() => keep.mutate({ id: conversation.id, body: { temporary: false } }, { onSuccess: () => setOpen(false) })}>
            Keep chat
          </Button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
