import { useEffect, useRef } from 'react'
import { NavLink, useMatch } from 'react-router'
import { Loader2, Star, Timer } from 'lucide-react'
import { useCurrentProject } from '@/app/projectStore'
import { ActionMenu } from '@/components/ui/ActionMenu'
import { cn } from '@/lib/cn'
import { dayLabel } from '@/lib/format'
import { type Conversation, useConversations } from '../api'
import { useChatActions } from '../chatActions'
import { formatRemaining, useNow } from '../remaining'

/** How long a temporary chat has left, at a glance ("4m"). */
function TimeLeft({ expiresAt }: { expiresAt: string }) {
  const now = useNow(15_000)
  return (
    <span className="shrink-0 text-[11px] tabular-nums text-subtle group-hover:invisible" title="Deleted unless you keep it">
      {formatRemaining(new Date(expiresAt).getTime() - now, 'short')}
    </span>
  )
}

function Item({ conv }: { conv: Conversation }) {
  const actions = useChatActions(conv)
  // The open chat stays in sight, also when it is further down than the list shows.
  const open = useMatch(`/c/${conv.id}`) !== null
  const row = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open) row.current?.scrollIntoView({ block: 'nearest' })
  }, [open])
  return (
    <div ref={row} className="group relative">
      <NavLink
        to={`/c/${conv.id}`}
        className={({ isActive }) =>
          cn(
            'flex h-9 items-center gap-2 rounded-control pl-3 pr-9 text-[13px] pointer-coarse:h-11 pointer-coarse:pr-11 pointer-coarse:text-[15px]',
            isActive ? 'bg-accent-soft font-medium text-text' : 'text-muted hover:bg-surface-hover hover:text-text',
          )
        }
      >
        {conv.active_run_id && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />}
        <span className="min-w-0 flex-1 truncate" title={conv.snippet ?? conv.title}>{conv.title}</span>
        {conv.temporary && conv.expires_at && !conv.active_run_id && <TimeLeft expiresAt={conv.expires_at} />}
      </NavLink>
      {/* Hover (or keyboard focus) reveals the menu; touch screens always show it. */}
      <ActionMenu actions={actions} label={`Actions for ${conv.title}`}
        className="absolute right-0 top-0 h-9 w-9 opacity-0 focus:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 pointer-coarse:h-11 pointer-coarse:w-11 pointer-coarse:opacity-100" />
    </div>
  )
}

type Group = { label: string; kind?: 'temporary' | 'favorites'; chats: Conversation[] }

/** Temporary chats first (they go soon), then favorites, then one group per day:
 *  Today, Yesterday, Past week, then dates.
 *  The server already sorts by latest message, so chats of one day are next to each other. */
function groupChats(all: Conversation[]): Group[] {
  const groups: Group[] = []
  const temporary = all.filter((c) => c.temporary)
  if (temporary.length) groups.push({ label: 'Temporary', kind: 'temporary', chats: temporary })
  const favorites = all.filter((c) => c.pinned && !c.temporary)
  if (favorites.length) groups.push({ label: 'Favorites', kind: 'favorites', chats: favorites })
  for (const chat of all.filter((c) => !c.pinned && !c.temporary)) {
    const label = dayLabel(chat.last_message_at)
    const last = groups[groups.length - 1]
    if (last && !last.kind && last.label === label) last.chats.push(chat)
    else groups.push({ label, chats: [chat] })
  }
  return groups
}

/**
 * The chats in the sidebar, for the project chosen in the switcher (or all of them).
 * They take all the free height and scroll on their own. Finding a chat is up to the
 * search (Ctrl+K) or the All chats page; a filter here would only be a weaker copy.
 */
export function ConversationList() {
  const project = useCurrentProject()
  const conversations = useConversations('', { projectId: project?.id })
  const all = conversations.data ?? []
  const groups = groupChats(all)

  return (
    <div className="mt-3 flex min-h-0 flex-1 flex-col">
      <div aria-label="Chats" className="min-h-0 flex-1 overflow-y-auto">
        {groups.map((group) => (
          <section key={group.label}>
            <div className="sticky top-0 z-10 flex h-7 items-center gap-1 bg-surface px-3 text-[11px] font-semibold uppercase tracking-wider text-subtle">
              {group.kind === 'favorites' && <Star className="h-3 w-3" />}
              {group.kind === 'temporary' && <Timer className="h-3 w-3 text-accent" />} {group.label}
            </div>
            {group.chats.map((c) => <Item key={c.id} conv={c} />)}
          </section>
        ))}
        {conversations.data && all.length === 0 && (
          <p className="px-3 py-2 text-[12px] text-subtle">
            {project ? `No chats in ${project.name} yet.` : 'No chats yet.'}
          </p>
        )}
      </div>
    </div>
  )
}
