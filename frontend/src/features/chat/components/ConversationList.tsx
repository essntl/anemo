import { useEffect, useState } from 'react'
import { NavLink } from 'react-router'
import { Loader2, Search, Star } from 'lucide-react'
import { useCurrentProject } from '@/app/projectStore'
import { ActionMenu } from '@/components/ui/ActionMenu'
import { cn } from '@/lib/cn'
import { dayLabel } from '@/lib/format'
import { type Conversation, useConversations } from '../api'
import { useChatActions } from '../chatActions'

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms)
    return () => window.clearTimeout(t)
  }, [value, ms])
  return debounced
}

function Item({ conv }: { conv: Conversation }) {
  const actions = useChatActions(conv)
  return (
    <div className="group relative">
      <NavLink
        to={`/c/${conv.id}`}
        className={({ isActive }) =>
          cn(
            'flex h-9 items-center gap-2 rounded-control pl-3 pr-9 text-[13px] pointer-coarse:h-11 pointer-coarse:pr-11 pointer-coarse:text-[15px]',
            isActive ? 'bg-surface-hover text-text' : 'text-muted hover:bg-surface-hover hover:text-text',
          )
        }
      >
        {conv.active_run_id && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />}
        <span className="min-w-0 flex-1 truncate" title={conv.snippet ?? conv.title}>{conv.title}</span>
      </NavLink>
      {/* Hover (or keyboard focus) reveals the menu; touch screens always show it. */}
      <ActionMenu actions={actions} label={`Actions for ${conv.title}`}
        className="absolute right-0 top-0 h-9 w-9 opacity-0 focus:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 pointer-coarse:h-11 pointer-coarse:w-11 pointer-coarse:opacity-100" />
    </div>
  )
}

/** With the menu below it open, the list shows this many chats; more than that and it scrolls. */
const VISIBLE_CHATS = 7

type Group = { label: string; favorites?: boolean; chats: Conversation[] }

/** Favorites first, then one group per day: Today, Yesterday, Past week, then dates.
 *  The server already sorts by latest message, so chats of one day are next to each other. */
function groupChats(all: Conversation[], searching: boolean): Group[] {
  if (searching) return all.length ? [{ label: 'Results', chats: all }] : []
  const groups: Group[] = []
  const favorites = all.filter((c) => c.pinned)
  if (favorites.length) groups.push({ label: 'Favorites', favorites: true, chats: favorites })
  for (const chat of all.filter((c) => !c.pinned)) {
    const label = dayLabel(chat.last_message_at)
    const last = groups[groups.length - 1]
    if (last && !last.favorites && last.label === label) last.chats.push(chat)
    else groups.push({ label, chats: [chat] })
  }
  return groups
}

/** How many group headings sit above or between the first `VISIBLE_CHATS` chats. */
function headingsInView(groups: Group[]): number {
  let chats = 0
  let headings = 0
  for (const group of groups) {
    if (chats >= VISIBLE_CHATS) break
    headings += 1
    chats += group.chats.length
  }
  return headings
}

/**
 * The chats in the sidebar, for the project chosen in the switcher (or all of them).
 * `fill`: take all the free height (the menu below is closed) instead of stopping
 * at seven chats.
 */
export function ConversationList({ fill }: { fill: boolean }) {
  const [query, setQuery] = useState('')
  const q = useDebounced(query.trim(), 250)
  const project = useCurrentProject()
  const conversations = useConversations(q, { projectId: project?.id })
  const all = conversations.data ?? []
  const groups = groupChats(all, Boolean(q))

  return (
    <div className={cn('mt-3', fill && 'flex min-h-0 flex-1 flex-col')}>
      <div className="relative mb-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={project ? `Search chats in ${project.name}` : 'Search chats'}
          aria-label="Search chats"
          className="h-8 w-full rounded-control bg-surface-2 pl-8 pr-3 pointer-coarse:h-10 text-[12.5px] placeholder:text-subtle focus:outline-none focus:ring-2 focus:ring-accent-soft"
        />
      </div>
      {/* Menu open: tall enough for 7 chats and their headings, the rest by scrolling.
          --row matches the height of one chat (taller on touch screens). */}
      <div
        aria-label="Chats"
        className={cn('mt-2 overflow-y-auto [--row:2.25rem] pointer-coarse:[--row:2.75rem]', fill && 'min-h-0 flex-1')}
        style={
          !fill && all.length > VISIBLE_CHATS
            ? { maxHeight: `calc(${VISIBLE_CHATS} * var(--row) + ${headingsInView(groups)} * 1.75rem)` }
            : undefined
        }
      >
        {groups.map((group) => (
          <section key={group.label}>
            <div className="sticky top-0 z-10 flex h-7 items-center gap-1 bg-surface px-3 text-[11px] font-semibold uppercase tracking-wider text-subtle">
              {group.favorites && <Star className="h-3 w-3" />} {group.label}
            </div>
            {group.chats.map((c) => <Item key={c.id} conv={c} />)}
          </section>
        ))}
        {conversations.data && all.length === 0 && (
          <p className="px-3 py-2 text-[12px] text-subtle">
            {q ? 'No matches.' : project ? `No chats in ${project.name} yet.` : 'No chats yet.'}
          </p>
        )}
      </div>
    </div>
  )
}
