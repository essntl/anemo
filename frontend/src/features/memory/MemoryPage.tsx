/**
 * Memory: everything remembered about the user, in three tabs (kept in the URL):
 * memories in use, suggestions from conversations waiting for a decision, and
 * archived ones. Nothing is hidden: every memory can be edited or deleted here.
 */
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Archive, ArchiveRestore, Brain, Check, Download, MessageSquare, Pencil, Pin, PinOff, Plus, Search, Trash2, X } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { ActionMenu, type MenuAction } from '@/components/ui/ActionMenu'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { confirmDialog } from '@/components/ui/dialogs'
import { EmptyState } from '@/components/ui/EmptyState'
import { cn } from '@/lib/cn'
import {
  KIND_LABELS,
  type Memory,
  memoryExportUrl,
  type MemoryStatus,
  useApproveMemory,
  useDeleteMemory,
  useHandleSuggestions,
  useMemories,
  useMemorySummary,
  useUpdateMemory,
} from './api'
import { MemoryDialog } from './MemoryDialog'

const TABS: { id: MemoryStatus; label: string }[] = [
  { id: 'active', label: 'Memories' },
  { id: 'pending', label: 'Suggestions' },
  { id: 'archived', label: 'Archived' },
]

const EMPTY: Record<MemoryStatus, { title: string; description: string }> = {
  active: {
    title: 'Nothing remembered yet',
    description: 'Tell the assistant "remember that I…" in any chat, or add a memory here. It then knows it in every conversation.',
  },
  pending: {
    title: 'No suggestions',
    description: 'Things the assistant notices in your conversations show up here for you to approve.',
  },
  archived: { title: 'Nothing archived', description: 'Archived memories are kept but not used.' },
}

function MemoryRow({ memory, onEdit }: { memory: Memory; onEdit: (m: Memory) => void }) {
  const update = useUpdateMemory()
  const remove = useDeleteMemory()
  const approve = useApproveMemory()
  const suggestion = memory.status === 'pending'

  const confirmDelete = async () => {
    const ok = await confirmDialog({ title: 'Delete this memory?', message: memory.content, confirmLabel: 'Delete', danger: true })
    if (ok) remove.mutate(memory.id)
  }
  const actions: MenuAction[] = [
    { label: 'Edit', icon: <Pencil />, onSelect: () => onEdit(memory) },
    ...(memory.status === 'active'
      ? [
          {
            label: memory.pinned ? 'Use only when relevant' : 'Always in context',
            icon: memory.pinned ? <PinOff /> : <Pin />,
            onSelect: () => update.mutate({ id: memory.id, body: { pinned: !memory.pinned } }),
          },
          { label: 'Archive', icon: <Archive />, onSelect: () => update.mutate({ id: memory.id, body: { status: 'archived' as const } }) },
        ]
      : []),
    ...(memory.status === 'archived'
      ? [{ label: 'Use again', icon: <ArchiveRestore />, onSelect: () => update.mutate({ id: memory.id, body: { status: 'active' as const } }) }]
      : []),
    { label: 'Delete', icon: <Trash2 />, danger: true, onSelect: () => void confirmDelete() },
  ]
  const error = update.error ?? remove.error ?? approve.error

  return (
    <div className="rounded-card border border-border bg-card px-4 py-3 shadow-soft">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="whitespace-pre-wrap break-words text-[14px]">{memory.content}</p>
          {memory.replaces_content && (
            <p className="mt-1 text-[12.5px] text-muted">
              Replaces: <span className="line-through">{memory.replaces_content}</span>
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
            <Badge tone={memory.kind === 'instruction' ? 'accent' : 'neutral'}>{KIND_LABELS[memory.kind]}</Badge>
            {memory.pinned && <Badge tone="accent"><Pin className="mr-1 h-3 w-3" />Always</Badge>}
            {memory.source === 'extracted' && <span>Noticed in a chat</span>}
            {memory.source === 'explicit' && <span>You asked to remember</span>}
            {memory.source_conversation_id && (
              <Link to={`/c/${memory.source_conversation_id}`} className="inline-flex items-center gap-1 text-accent hover:underline">
                <MessageSquare className="h-3 w-3" /> Open chat
              </Link>
            )}
            {memory.use_count > 0 && <span>· used {memory.use_count}×</span>}
          </div>
        </div>
        <ActionMenu actions={actions} />
      </div>
      {suggestion && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="primary" icon={<Check className="h-3.5 w-3.5" />} loading={approve.isPending}
            onClick={() => approve.mutate({ id: memory.id })}>
            Save to memory
          </Button>
          <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />} loading={remove.isPending}
            onClick={() => remove.mutate(memory.id)}>
            Dismiss
          </Button>
        </div>
      )}
      {error && <p className="mt-2 text-[12px] text-error">{errorMessage(error)}</p>}
    </div>
  )
}

export function MemoryPage() {
  const [params, setParams] = useSearchParams()
  const tab = (TABS.find((t) => t.id === params.get('tab'))?.id ?? 'active') as MemoryStatus
  const [query, setQuery] = useState('')
  // null: closed. { memory: null }: adding a new one.
  const [editing, setEditing] = useState<{ memory: Memory | null } | null>(null)
  const memories = useMemories(tab, query.trim())
  const summary = useMemorySummary()
  const bulk = useHandleSuggestions()
  const items = memories.data ?? []

  return (
    <div className="mx-auto max-w-3xl p-4 md:p-8">
      <div className="mb-5 flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Brain className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold">Memory</h1>
          <p className="text-[13px] text-muted">
            What the assistant remembers about you across conversations. You can change or delete anything.{' '}
            <Link to="/settings/memory" className="text-accent underline">Settings</Link>
          </p>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-lg bg-surface-2 p-0.5" role="tablist" aria-label="Memory lists">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id}
              onClick={() => setParams(t.id === 'active' ? {} : { tab: t.id }, { replace: true })}
              className={cn('flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-colors pointer-coarse:h-10',
                tab === t.id ? 'bg-surface text-text shadow-soft' : 'text-muted hover:text-text')}>
              {t.label}
              {t.id === 'pending' && Boolean(summary.data?.pending) && (
                <span className="rounded-full bg-warning px-1.5 text-[11px] font-semibold text-white">{summary.data?.pending}</span>
              )}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({ memory: null })}>
            Add memory
          </Button>
          <ActionMenu actions={[{ label: 'Export all (JSON)', icon: <Download />, download: memoryExportUrl }]} />
        </div>
      </div>

      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search memories" aria-label="Search memories"
          className="h-10 w-full rounded-control border border-border bg-surface pl-9 pr-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft" />
      </div>

      {tab === 'pending' && items.length > 1 && (
        <div className="mb-3 flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" loading={bulk.isPending} onClick={() => bulk.mutate('approve_all')}>
            Save all {items.length}
          </Button>
          <Button size="sm" variant="ghost" disabled={bulk.isPending} onClick={() => bulk.mutate('dismiss_all')}>
            Dismiss all
          </Button>
        </div>
      )}

      {memories.isError && <p className="text-[13px] text-error">{errorMessage(memories.error)}</p>}
      {memories.isSuccess && items.length === 0 && (
        <EmptyState icon={<Brain className="h-5 w-5" />}
          title={query ? 'No matches' : EMPTY[tab].title}
          description={query ? 'No memory contains that text.' : EMPTY[tab].description} />
      )}
      <div className="flex flex-col gap-2">
        {items.map((m) => <MemoryRow key={m.id} memory={m} onEdit={(memory) => setEditing({ memory })} />)}
      </div>

      {editing && <MemoryDialog memory={editing.memory} onClose={() => setEditing(null)} />}
    </div>
  )
}
