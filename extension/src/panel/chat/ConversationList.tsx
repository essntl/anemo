import { useState } from 'react'
import { MessageSquare, Plus, Search, Star } from 'lucide-react'
import { formatWhen } from '@/shared/format'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { cn } from '../lib/cn'
import { useConversations } from './api'

/** The chats you have in Anemo (the same list), newest first, with search. */
export function ConversationList({ current, onOpen, onNew }: { current: string | null; onOpen: (id: string) => void; onNew: () => void }) {
  const [q, setQ] = useState('')
  const list = useConversations(q.trim())
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border p-2.5">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-subtle" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats" aria-label="Search chats" className="pl-8" />
        </div>
        <Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={onNew}>New</Button>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto p-1.5" aria-label="Chats">
        {list.isError && <li className="p-3 text-[12.5px] text-error">{(list.error as Error).message}</li>}
        {list.data?.length === 0 && <li className="p-3 text-[12.5px] text-muted">{q ? 'No chat matches.' : 'No chats yet.'}</li>}
        {list.data?.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onOpen(c.id)}
              className={cn('flex w-full items-start gap-2 rounded-control px-2.5 py-2 text-left hover:bg-surface-hover', c.id === current && 'bg-accent-soft')}
            >
              <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-subtle" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1 truncate text-[13px] font-medium">
                  {c.pinned && <Star className="h-3 w-3 shrink-0 fill-current text-warning" />}
                  <span className="truncate">{c.title}</span>
                </span>
                {c.snippet ? (
                  <span className="line-clamp-2 text-[12px] text-muted">{c.snippet}</span>
                ) : (
                  <span className="text-[11.5px] text-subtle">{formatWhen(c.last_message_at)}{c.active_run_id ? ' · answering…' : ''}</span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
