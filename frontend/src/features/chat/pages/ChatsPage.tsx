/**
 * All chats in one place: search, filter by project, tag, favorites or archive, sort,
 * and change several at once. Filters are kept in the URL (?q=…&project=…&tag=…&show=…&sort=…),
 * so a filtered view can be bookmarked.
 */
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Archive, ArchiveRestore, FolderInput, MessagesSquare, Star, StarOff, Tags, Trash2, X } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { ActionMenu } from '@/components/ui/ActionMenu'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { confirmDialog, promptDialog } from '@/components/ui/dialogs'
import { EmptyState } from '@/components/ui/EmptyState'
import { Select } from '@/components/ui/Select'
import { type Project, useProjects } from '@/features/tasks/api'
import { cn } from '@/lib/cn'
import { formatWhen } from '@/lib/format'
import { AGES, ageRange } from '../age'
import { type BulkAction, type ChatFilters, type Conversation, useBulkChats, useChatTags, useConversations } from '../api'
import { useChatActions, useMoveChats } from '../chatActions'

const PAGE = 50
const SORTS = [
  { value: 'recent', label: 'Latest' },
  { value: 'created', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'title', label: 'Title A–Z' },
]
const SHOW = [
  { value: '', label: 'Active' },
  { value: 'favorites', label: 'Favorites' },
  { value: 'archived', label: 'Archived' },
]
/** A filter as a small pill that is only as wide as its text, so four fit on a phone. */
const PILL = 'h-8 w-auto max-w-[11rem] gap-1 rounded-full bg-surface-2 border-transparent pl-3 pr-2 text-[12.5px] pointer-coarse:h-9'

/** One action for the selected chats: an outlined button; on a phone just its icon. */
function BulkButton({ label, icon, disabled, onClick }: { label: string; icon: ReactNode; disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick}
      className="flex h-8 items-center justify-center gap-1.5 rounded-control border border-border text-[13px] font-medium text-muted transition-colors hover:bg-surface-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted max-sm:w-9 sm:px-2.5 pointer-coarse:h-9 [&>svg]:h-3.5 [&>svg]:w-3.5">
      {icon}
      <span className="max-sm:hidden">{label}</span>
    </button>
  )
}

function Row({ conv, project, selected, onToggle }: { conv: Conversation; project?: Project; selected: boolean; onToggle: () => void }) {
  const actions = useChatActions(conv)
  return (
    <div className={cn('flex items-center gap-2 border-b border-border px-2 py-1.5 last:border-0 md:px-3', selected && 'bg-accent-soft/50')}>
      <Checkbox checked={selected} onChange={onToggle} aria-label={`Select ${conv.title}`} />
      <Link to={`/c/${conv.id}`} className="min-w-0 flex-1 rounded-control px-1 py-1 hover:bg-surface-hover">
        <span className="flex items-center gap-1.5">
          {conv.pinned && <Star className="h-3.5 w-3.5 shrink-0 fill-current text-warning" aria-label="Favorite" />}
          <span className="truncate text-[14px] font-medium">{conv.title}</span>
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-muted">
          <span>{formatWhen(conv.last_message_at)}</span>
          {project && (
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: project.color }} /> {project.name}
            </span>
          )}
          {conv.tags.map((tag) => <span key={tag}>#{tag}</span>)}
          {conv.archived && <Badge>Archived</Badge>}
        </span>
        {conv.snippet && <span className="mt-0.5 block truncate text-[12px] text-subtle">{conv.snippet}</span>}
      </Link>
      <ActionMenu actions={actions} label={`Actions for ${conv.title}`} />
    </div>
  )
}

export function ChatsPage() {
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const projectId = params.get('project') ?? ''
  const tag = params.get('tag') ?? ''
  const show = params.get('show') ?? ''
  const age = params.get('age') ?? ''
  const sort = (params.get('sort') ?? 'recent') as NonNullable<ChatFilters['sort']>
  const [search, setSearch] = useState(q)
  const [pages, setPages] = useState(1)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next, { replace: true })
    setPages(1)
    setSelected(new Set())
  }
  // Search as you type, a moment after the last key.
  useEffect(() => {
    if (search.trim() === q) return
    const t = window.setTimeout(() => setParam('q', search.trim()), 250)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the text changes
  }, [search])

  const projects = useProjects()
  const tags = useChatTags()
  // Worked out once per choice, so the list is not asked for again on every render.
  const range = useMemo(() => ageRange(age), [age])
  const projectMap = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, p])), [projects.data])
  const chats = useConversations(q, {
    projectId: projectId || null,
    tag,
    favorite: show === 'favorites',
    archived: show === 'archived',
    sort,
    activeAfter: range.after,
    activeBefore: range.before,
    limit: PAGE * pages + 1, // one extra tells whether there are more
  })
  const all = chats.data ?? []
  const shown = all.slice(0, PAGE * pages)
  const hasMore = all.length > shown.length

  const bulk = useBulkChats()
  const askMove = useMoveChats((s) => s.ask)
  const ids = [...selected].filter((id) => shown.some((c) => c.id === id))
  // The two buttons that can be undone do the opposite when every selected chat is
  // already a favorite (or archived): "Favorite" becomes "Unfavorite", and so on.
  const picked = shown.filter((c) => selected.has(c.id))
  const allFavorites = picked.length > 0 && picked.every((c) => c.pinned)
  const allArchived = picked.length > 0 ? picked.every((c) => c.archived) : show === 'archived'
  const allSelected = shown.length > 0 && picked.length === shown.length
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const run = (action: BulkAction, extra: { tag?: string } = {}) =>
    // The selection stays, so several things can be done to the same chats
    // (chats that leave the list, e.g. when archived, drop out of it by themselves).
    bulk.mutate({ ids, action, ...extra })
  const addTag = async () => {
    const name = await promptDialog({ title: `Tag ${ids.length} chat${ids.length === 1 ? '' : 's'}`, label: 'Tag', placeholder: 'e.g. ideas', confirmLabel: 'Add tag' })
    if (name) run('add_tag', { tag: name })
  }
  const deleteSelected = async () => {
    const ok = await confirmDialog({
      title: `Delete ${ids.length} chat${ids.length === 1 ? '' : 's'}?`,
      message: 'The chats and their attachments are deleted. This cannot be undone.',
      confirmLabel: 'Delete', danger: true,
    })
    if (ok) bulk.mutate({ ids, action: 'delete' }, { onSuccess: () => setSelected(new Set()) })
  }

  return (
    <div className="mx-auto max-w-3xl p-4 md:p-8">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <MessagesSquare className="h-5 w-5" />
        </div>
        <h1 className="min-w-0 flex-1 text-xl font-semibold">All chats</h1>
      </div>

      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search in titles and messages" aria-label="Search chats"
        className="mb-2 h-10 w-full rounded-control border border-border bg-surface px-3 text-[13px] focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft" />
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <Select className={PILL} aria-label="Project" value={projectId} onValueChange={(v) => setParam('project', v)}
          options={[{ value: '', label: 'All projects' }, ...(projects.data ?? []).map((p) => ({ value: p.id, label: p.name }))]} />
        {(tags.data?.length ?? 0) > 0 && (
          <Select className={PILL} aria-label="Tag" value={tag} onValueChange={(v) => setParam('tag', v)}
            options={[{ value: '', label: 'All tags' }, ...(tags.data ?? []).map((t) => ({ value: t.tag, label: `#${t.tag} (${t.count})` }))]} />
        )}
        <Select className={PILL} aria-label="Show" value={show} onValueChange={(v) => setParam('show', v)} options={SHOW} />
        <Select className={PILL} aria-label="Last active" value={age} onValueChange={(v) => setParam('age', v)} options={AGES} />
        <Select className={PILL} aria-label="Sort by" value={sort} onValueChange={(v) => setParam('sort', v === 'recent' ? '' : v)} options={SORTS} />
      </div>

      {(chats.error ?? bulk.error) && <p className="mb-2 text-[13px] text-error">{errorMessage(chats.error ?? bulk.error)}</p>}

      {/* Select all, and what to do with the selection. The actions are always there
          (greyed out until something is selected), so the bar never changes size. */}
      <div className="mb-2 flex h-12 items-center gap-2 rounded-card border border-border bg-card px-2 shadow-soft md:px-3 pointer-coarse:h-14">
        <label className="flex min-w-0 items-center gap-2 whitespace-nowrap text-[13px] text-muted">
          <Checkbox checked={allSelected} disabled={shown.length === 0} aria-label="Select all shown"
            onChange={() => setSelected(allSelected ? new Set() : new Set(shown.map((c) => c.id)))} />
          {ids.length === 0 && <span className="truncate">{shown.length}{hasMore ? '+' : ''} chat{shown.length === 1 ? '' : 's'}</span>}
        </label>
        {ids.length > 0 && (
          // The count doubles as the way to let go of the selection.
          <button type="button" aria-label="Clear selection" title="Clear selection" onClick={() => setSelected(new Set())}
            className="-ml-0.5 flex h-7 shrink-0 items-center gap-1 rounded-full bg-accent-soft pl-2.5 pr-1.5 text-[12.5px] font-medium text-accent hover:bg-accent-soft/70 pointer-coarse:h-8">
            {ids.length}<span className="max-sm:hidden"> selected</span> <X className="h-3.5 w-3.5" />
          </button>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-1.5" role="toolbar" aria-label="Actions for the selected chats">
          {allArchived
            ? <BulkButton label="Unarchive" icon={<ArchiveRestore />} disabled={!ids.length} onClick={() => run('unarchive')} />
            : <BulkButton label="Archive" icon={<Archive />} disabled={!ids.length} onClick={() => run('archive')} />}
          {allFavorites
            ? <BulkButton label="Unfavorite" icon={<StarOff />} disabled={!ids.length} onClick={() => run('unfavorite')} />
            : <BulkButton label="Favorite" icon={<Star />} disabled={!ids.length} onClick={() => run('favorite')} />}
          <BulkButton label="Tag" icon={<Tags />} disabled={!ids.length} onClick={() => void addTag()} />
          <BulkButton label="Move" icon={<FolderInput />} disabled={!ids.length} onClick={() => askMove(ids)} />
          <BulkButton label="Delete" icon={<Trash2 />} disabled={!ids.length} onClick={() => void deleteSelected()} />
        </div>
      </div>

      {chats.isSuccess && shown.length === 0 ? (
        <EmptyState icon={<MessagesSquare className="h-5 w-5" />} title="No chats here"
          description={q || projectId || tag || show || age ? 'Nothing matches these filters.' : 'Start one with “New chat”.'} />
      ) : (
        <div className="overflow-hidden rounded-card border border-border bg-card shadow-soft">
          {shown.map((conv) => (
            <Row key={conv.id} conv={conv} project={conv.project_id ? projectMap.get(conv.project_id) : undefined}
              selected={selected.has(conv.id)} onToggle={() => toggle(conv.id)} />
          ))}
        </div>
      )}
      {hasMore && (
        <div className="mt-3 flex justify-center">
          <Button variant="secondary" loading={chats.isFetching} onClick={() => setPages(pages + 1)}>Show more</Button>
        </div>
      )}
    </div>
  )
}
