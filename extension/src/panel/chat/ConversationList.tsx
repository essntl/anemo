/**
 * Your chats in Anemo (the same list), as in Anemo's sidebar: temporary chats first, then
 * favorites, then by day. Search, the archived ones, and a menu on each chat (keep,
 * rename, favorite, archive, delete).
 */
import { useState } from 'react'
import { Archive, MessageSquare, Plus, Search, Star, Timer } from 'lucide-react'
import { dayLabel, formatRemaining, formatWhen } from '@/shared/format'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { ActionMenu } from '../ui/Menu'
import { cn } from '../lib/cn'
import { useConversations, type Conversation } from './api'
import { useChatMenu } from './chatMenu'
import { useNow } from '../state/useNow'

type Group = { label: string; kind?: 'temporary' | 'favorites'; chats: Conversation[] }

function groupChats(all: Conversation[], searching: boolean): Group[] {
  if (searching) return all.length ? [{ label: 'Results', chats: all }] : []
  const groups: Group[] = []
  const temporary = all.filter((c) => c.temporary)
  if (temporary.length) groups.push({ label: 'Temporary', kind: 'temporary', chats: temporary })
  const favorites = all.filter((c) => c.pinned && !c.temporary)
  if (favorites.length) groups.push({ label: 'Favorites', kind: 'favorites', chats: favorites })
  for (const chat of all.filter((c) => !c.pinned && !c.temporary)) {
    const label = dayLabel(chat.last_message_at)
    const last = groups.at(-1)
    if (last && !last.kind && last.label === label) last.chats.push(chat)
    else groups.push({ label, chats: [chat] })
  }
  return groups
}

function TimeLeft({ expiresAt }: { expiresAt: string }) {
  const now = useNow(15_000)
  return <span className="shrink-0 text-[11px] tabular-nums text-accent">{formatRemaining(new Date(expiresAt).getTime() - now, 'short')}</span>
}

function ChatRow({ conv, current, onOpen, onDeleted }: { conv: Conversation; current: boolean; onOpen: () => void; onDeleted: () => void }) {
  const menu = useChatMenu(conv, { onDeleted })
  return (
    <li className={cn('group relative flex items-center rounded-control', current ? 'bg-accent-soft' : 'hover:bg-surface-hover')}>
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-start gap-2.5 px-2.5 py-2 text-left" aria-current={current ? 'true' : undefined}>
        {conv.temporary ? <Timer className="mt-0.5 h-4 w-4 shrink-0 text-accent" /> : <MessageSquare className={cn('mt-0.5 h-4 w-4 shrink-0', current ? 'text-accent' : 'text-subtle')} />}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-medium">{conv.title}</span>
            {conv.active_run_id && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" aria-label="Answering" />}
          </span>
          <span className="flex items-center gap-1.5 text-[11.5px] text-subtle">
            <span className="truncate">{conv.snippet || formatWhen(conv.last_message_at)}</span>
            {conv.temporary && conv.expires_at && !conv.active_run_id && <TimeLeft expiresAt={conv.expires_at} />}
          </span>
        </span>
      </button>
      {/* On hover or keyboard focus, and while its menu is open. */}
      <div className="pr-1 opacity-0 focus-within:opacity-100 group-hover:opacity-100 has-[[data-state=open]]:opacity-100">
        <ActionMenu actions={menu.actions} label={`Actions for ${conv.title}`} />
      </div>
      {menu.dialogs}
    </li>
  )
}

export function ConversationList({ current, onOpen, onNew, onCurrentDeleted }: { current: string | null; onOpen: (id: string) => void; onNew: (temporary: boolean) => void; onCurrentDeleted: () => void }) {
  const [q, setQ] = useState('')
  const [archived, setArchived] = useState(false)
  const list = useConversations(q.trim(), archived)
  const groups = groupChats(list.data ?? [], Boolean(q.trim()))
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 border-b border-border p-2.5">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-subtle" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats" aria-label="Search chats" className="pl-8" />
          </div>
          <Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => onNew(false)}>
            New
          </Button>
        </div>
        <div className="flex items-center gap-1">
          <div role="tablist" aria-label="Which chats" className="flex rounded-control bg-surface-2 p-0.5">
            {[false, true].map((a) => (
              <button
                key={String(a)}
                type="button"
                role="tab"
                aria-selected={archived === a}
                onClick={() => setArchived(a)}
                className={cn('flex items-center gap-1 rounded-[8px] px-2.5 py-1 text-[12px] font-medium', archived === a ? 'bg-surface text-text shadow-soft' : 'text-muted hover:text-text')}
              >
                {a && <Archive className="h-3 w-3" />}
                {a ? 'Archived' : 'Chats'}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          <button type="button" onClick={() => onNew(true)} className="flex items-center gap-1 rounded-full border border-dashed border-border px-2.5 py-1 text-[12px] text-muted hover:border-accent hover:text-accent">
            <Timer className="h-3 w-3" /> Temporary chat
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2" aria-label="Chats" role="region">
        {list.isError && <p className="p-3 text-[12.5px] text-error">{(list.error as Error).message}</p>}
        {list.isPending && <p className="p-3 text-[12.5px] text-muted">Loading…</p>}
        {list.data?.length === 0 && (
          <div className="flex flex-col items-center gap-1.5 px-4 py-10 text-center">
            {archived ? <Archive className="h-6 w-6 text-subtle" /> : <MessageSquare className="h-6 w-6 text-subtle" />}
            <p className="text-[13px] font-medium">{q ? 'No chat matches' : archived ? 'Nothing archived' : 'No chats yet'}</p>
            <p className="text-[12px] text-muted">{q ? 'Try other words.' : archived ? 'Chats you archive are kept here.' : 'Start one with New.'}</p>
          </div>
        )}
        {groups.map((g) => (
          <section key={g.label} aria-label={g.label}>
            <h3 className="sticky top-0 z-10 flex h-7 items-center gap-1 bg-bg px-2.5 pt-1 text-[11px] font-semibold uppercase tracking-wider text-subtle">
              {g.kind === 'favorites' && <Star className="h-3 w-3" />}
              {g.kind === 'temporary' && <Timer className="h-3 w-3" />}
              {g.label}
            </h3>
            <ul className="flex flex-col gap-0.5">
              {g.chats.map((c) => (
                <ChatRow key={c.id} conv={c} current={c.id === current} onOpen={() => onOpen(c.id)} onDeleted={() => (c.id === current ? onCurrentDeleted() : undefined)} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}
