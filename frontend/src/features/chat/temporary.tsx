/**
 * Temporary chats: deleted five minutes after their last message unless kept
 * (the server does it; see conversations.service.TEMPORARY_FOR). This label sits next
 * to the chat's name with the time left; pointing at it (or tapping it) explains what
 * it means and offers to keep the chat.
 */
import { type PointerEvent, useCallback, useRef, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { Timer } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { useCloseOnScroll } from '@/hooks/useCloseOnScroll'
import { type Conversation, useUpdateConversation } from './api'
import { formatRemaining, useNow } from './remaining'

export function TemporaryLabel({ conversation }: { conversation: Conversation }) {
  const keep = useUpdateConversation()
  const now = useNow(1000)
  const [open, setOpen] = useState(false)
  useCloseOnScroll(open, useCallback(() => setOpen(false), []))
  // With a mouse it opens while the pointer is on the label or the card, with a moment's
  // grace to move from one to the other. A tap is left to the click: touch screens also
  // report the finger "entering" the label, and opening on that would make the click
  // that follows close the card again at once.
  const closing = useRef<number>(undefined)
  const hovering = useRef(false)
  const show = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return
    hovering.current = true
    window.clearTimeout(closing.current)
    setOpen(true)
  }
  const hide = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return
    hovering.current = false
    closing.current = window.setTimeout(() => setOpen(false), 150)
  }
  // A click opens and closes it; one while the mouse already opened it keeps it open.
  const toggle = (e: { preventDefault: () => void }) => {
    e.preventDefault() // instead of the popover's own toggling
    setOpen((was) => hovering.current || !was)
  }

  const left = conversation.expires_at ? new Date(conversation.expires_at).getTime() - now : 0
  // While an answer is being written the five minutes have not started yet.
  const answering = Boolean(conversation.active_run_id)
  const time = answering ? '5:00' : formatRemaining(left, 'clock')
  const when = answering
    ? 'It is deleted 5 minutes after the answer'
    : left > 0 ? `It is deleted in ${time} (5 minutes after the last message)` : 'It is being deleted'

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" aria-label={`Temporary chat, ${time} left`}
          onPointerEnter={show} onPointerLeave={hide} onClick={toggle}
          className="flex h-6 shrink-0 items-center gap-1 rounded-full border border-dashed border-accent/60 bg-accent-soft/50 px-2 text-[12px] font-medium tabular-nums text-accent hover:bg-accent-soft pointer-coarse:h-8">
          <Timer className="h-3.5 w-3.5" /> {time}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} collisionPadding={12} onPointerEnter={show} onPointerLeave={hide}
          className="pop z-50 w-72 rounded-card border border-border bg-card p-3.5 text-[13px] shadow-float">
          <p className="flex items-center gap-1.5 font-semibold"><Timer className="h-4 w-4 text-accent" /> Temporary chat</p>
          <p className="mt-1.5 text-muted">{when} unless you keep it. Nothing is remembered from it.</p>
          {keep.isError && <p className="mt-2 text-error">{errorMessage(keep.error)}</p>}
          <Button size="sm" variant="primary" className="mt-3 w-full justify-center" loading={keep.isPending}
            onClick={() => keep.mutate({ id: conversation.id, body: { temporary: false } }, { onSuccess: () => setOpen(false) })}>
            Keep chat
          </Button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
