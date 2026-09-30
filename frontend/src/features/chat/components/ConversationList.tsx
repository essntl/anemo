import { useEffect, useState } from 'react'
import { NavLink, useNavigate, useParams } from 'react-router'
import { Loader2, Pencil, Pin, Search, Trash2 } from 'lucide-react'
import { confirmDialog, promptDialog } from '@/components/ui/dialogs'
import { cn } from '@/lib/cn'
import { type Conversation, useConversations, useDeleteConversation, useUpdateConversation } from '../api'

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms)
    return () => window.clearTimeout(t)
  }, [value, ms])
  return debounced
}

function Item({ conv }: { conv: Conversation }) {
  const navigate = useNavigate()
  const { conversationId } = useParams()
  const update = useUpdateConversation()
  const remove = useDeleteConversation()

  const rename = async () => {
    const title = await promptDialog({ title: 'Rename chat', label: 'Title', initial: conv.title, confirmLabel: 'Rename' })
    if (title) update.mutate({ id: conv.id, body: { title } })
  }
  const del = async () => {
    const ok = await confirmDialog({
      title: `Delete "${conv.title}"?`, message: 'The chat and its attachments are deleted. This cannot be undone.',
      confirmLabel: 'Delete', danger: true,
    })
    if (!ok) return
    remove.mutate(conv.id, { onSuccess: () => conversationId === conv.id && navigate('/') })
  }

  return (
    <NavLink
      to={`/c/${conv.id}`}
      className={({ isActive }) =>
        cn(
          'group flex h-9 items-center gap-2 rounded-control px-3 text-[13px] pointer-coarse:h-11 pointer-coarse:text-[15px]',
          isActive ? 'bg-surface-hover text-text' : 'text-muted hover:bg-surface-hover hover:text-text',
        )
      }
    >
      {conv.active_run_id && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />}
      <span className="min-w-0 flex-1 truncate" title={conv.snippet ?? conv.title}>{conv.title}</span>
      {/* Hover reveals the actions; touch screens (no hover) always show them. */}
      <span className="hidden shrink-0 items-center group-hover:flex pointer-coarse:flex" onClick={(e) => e.preventDefault()}>
        <button type="button" aria-label="Rename" onClick={() => void rename()} className="rounded p-1 hover:text-text pointer-coarse:p-2">
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button type="button" aria-label="Delete" onClick={() => void del()} className="rounded p-1 hover:text-error pointer-coarse:p-2">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </span>
    </NavLink>
  )
}

export function ConversationList() {
  const [query, setQuery] = useState('')
  const q = useDebounced(query.trim(), 250)
  const conversations = useConversations(q)
  const all = conversations.data ?? []
  const pinned = all.filter((c) => c.pinned)
  const recent = all.filter((c) => !c.pinned)

  return (
    <div className="mt-3">
      <div className="relative mb-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search chats"
          className="h-8 w-full rounded-control bg-surface-2 pl-8 pr-3 pointer-coarse:h-10 text-[12.5px] placeholder:text-subtle focus:outline-none focus:ring-2 focus:ring-accent-soft"
        />
      </div>
      {pinned.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 flex items-center gap-1 px-3 text-[11px] font-semibold uppercase tracking-wider text-subtle">
            <Pin className="h-3 w-3" /> Pinned
          </div>
          {pinned.map((c) => <Item key={c.id} conv={c} />)}
        </div>
      )}
      <div className="mt-2">
        <div className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-wider text-subtle">
          {q ? 'Results' : 'Chats'}
        </div>
        {recent.map((c) => <Item key={c.id} conv={c} />)}
        {conversations.data && all.length === 0 && (
          <p className="px-3 py-2 text-[12px] text-subtle">{q ? 'No matches.' : 'No chats yet.'}</p>
        )}
      </div>
    </div>
  )
}
