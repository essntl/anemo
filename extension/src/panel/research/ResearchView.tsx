/**
 * Research sessions (feature 8): a question, the sources you add to it by hand, a chat
 * that has them all as context, and a write-up at the end. One session is active at a time;
 * the panel header shows it, and "Add to research" (here, the right-click menu, Alt+Shift+R)
 * adds the page or the selection to it. Nothing is ever added on its own.
 */
import { useState } from 'react'
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  ExternalLink,
  FileText,
  FlaskConical,
  Loader2,
  MessageSquareText,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Star,
  TextSelect,
  Trash2,
  Video,
} from 'lucide-react'
import { PageReadError } from '@/shared/pageContext'
import { failureMessage } from '@/shared/pageFailure'
import { formatWhen } from '@/shared/format'
import { storage } from '@/shared/storage'
import { Button } from '../ui/Button'
import { Card, CardBody, CardHeader } from '../ui/Card'
import { Input, Textarea } from '../ui/Input'
import { Notice } from '../ui/Notice'
import { cn } from '../lib/cn'
import { useSession } from '../state/useSession'
import { useStored } from '../state/useStored'
import { AlwaysAllow } from '../sites/AlwaysAllow'
import { useFollowResearchChanges, useResearchMutations, useSessionDetail, useSessions, type Session, type SessionDetail, type Source } from './api'

type Shape = 'notes' | 'outline' | 'table'

const SHAPES: { value: Shape; label: string; hint: string }[] = [
  { value: 'notes', label: 'Notes', hint: 'The question, a synthesis, key findings, where sources disagree, open questions, sources.' },
  { value: 'outline', label: 'Essay outline', hint: 'A thesis and the sections of an essay, each with its evidence.' },
  { value: 'table', label: 'Comparison table', hint: 'The sources side by side on what they say, then the synthesis.' },
]

const STATUS: Record<string, string> = { active: 'Active', paused: 'Paused', ended: 'Ended' }

/** What went wrong, in words (a page that can't be read says why). */
function problem(err: unknown): string {
  if (err instanceof PageReadError) return failureMessage(err.failure).body
  return err instanceof Error ? err.message : String(err)
}

function host(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}

function open(sessionId: string | null): void {
  void storage.set('session', 'researchOpen', { sessionId })
}

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-[11px] font-medium',
        status === 'active' ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-muted',
      )}
    >
      {STATUS[status] ?? status}
    </span>
  )
}

/** Start a session, and the earlier ones to reopen. */
function SessionList({ sessions }: { sessions: Session[] }) {
  const { create } = useResearchMutations(null)
  const [topic, setTopic] = useState('')
  const active = sessions.find((s) => s.status === 'active')
  const start = () => {
    const t = topic.trim()
    if (!t) return
    // mutateAsync: this list unmounts as soon as the new session is the active one.
    void create.mutateAsync(t).then(
      (s) => {
        setTopic('')
        open(s.id)
      },
      () => undefined, // shown from create.error
    )
  }
  return (
    <div className="flex flex-col gap-3 p-3">
      <Card>
        <CardHeader title="Start a research session" description="Add pages to it as you go; Anemo can then answer across them and write it up." />
        <CardBody className="flex flex-col gap-2">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              start()
            }}
          >
            <Input aria-label="Topic or question" placeholder="What are you researching?" value={topic} maxLength={300} disabled={Boolean(active)} onChange={(e) => setTopic(e.target.value)} />
            <Button type="submit" variant="primary" size="md" disabled={Boolean(active) || !topic.trim()} loading={create.isPending}>
              Start
            </Button>
          </form>
          {active && <p className="text-[12px] text-muted">Pause or end “{active.topic}” to start another: one session is active at a time.</p>}
          {create.error && <p className="text-[12px] text-error">{problem(create.error)}</p>}
        </CardBody>
      </Card>
      {sessions.length > 0 && (
        <ul className="flex flex-col gap-1.5" aria-label="Research sessions">
          {sessions.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => open(s.id)} className="flex w-full items-start gap-2 rounded-control border border-border bg-surface px-3 py-2 text-left hover:bg-surface-hover">
                <FlaskConical className={cn('mt-0.5 h-4 w-4 shrink-0', s.status === 'active' ? 'text-accent' : 'text-subtle')} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{s.topic}</span>
                  <span className="block text-[12px] text-muted">
                    {s.source_count} {s.source_count === 1 ? 'source' : 'sources'} · {formatWhen(s.updated_at)}
                  </span>
                </span>
                <StatusPill status={s.status} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function KindIcon({ kind }: { kind: string }) {
  const cls = 'h-3.5 w-3.5 shrink-0 text-subtle'
  if (kind === 'youtube') return <Video className={cls} aria-label="Video" />
  if (kind === 'selection') return <TextSelect className={cls} aria-label="Selection" />
  return <FileText className={cls} aria-label={kind === 'pdf' ? 'PDF' : 'Page'} />
}

function SourceItem({
  source,
  number,
  sessionId,
  first,
  last,
  editing,
  onEdit,
  onMove,
}: {
  source: Source
  number: number
  sessionId: string
  first: boolean
  last: boolean
  editing: boolean
  onEdit: (editing: boolean) => void
  onMove: (by: -1 | 1) => void
}) {
  const m = useResearchMutations(sessionId)
  const [note, setNote] = useState(source.note)
  const [confirm, setConfirm] = useState(false)
  const saveNote = () => m.updateSource.mutate({ id: source.id, note }, { onSuccess: () => onEdit(false) })
  return (
    <li className={cn('rounded-control border bg-surface px-3 py-2', source.key ? 'border-accent/50' : 'border-border')} aria-label={source.title}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 w-7 shrink-0 text-[11.5px] font-medium text-subtle">S{number}</span>
        <div className="min-w-0 flex-1">
          <a href={source.url} target="_blank" rel="noopener noreferrer" className="block truncate text-[13px] font-medium hover:underline" title={source.url}>
            {source.title || source.url}
          </a>
          <div className="flex items-center gap-1 text-[11.5px] text-muted">
            <KindIcon kind={source.kind} />
            <span className="truncate">{host(source.url)}</span>
            <span>· {formatWhen(source.created_at)} · {source.word_count.toLocaleString()} words</span>
          </div>
        </div>
        <button
          type="button"
          aria-pressed={source.key}
          title={source.key ? 'Key source' : 'Mark as key source'}
          aria-label={source.key ? 'Key source' : 'Mark as key source'}
          onClick={() => m.updateSource.mutate({ id: source.id, key: !source.key })}
          className="rounded p-1 hover:bg-surface-hover"
        >
          <Star className={cn('h-4 w-4', source.key ? 'fill-accent text-accent' : 'text-subtle')} />
        </button>
      </div>
      {editing ? (
        <div className="mt-2 flex flex-col gap-1.5 pl-9">
          <Textarea aria-label={`Note on S${number}`} rows={2} maxLength={2000} value={note} autoFocus onChange={(e) => setNote(e.target.value)} />
          <div className="flex gap-1.5">
            <Button size="sm" variant="primary" icon={<Check className="h-3.5 w-3.5" />} loading={m.updateSource.isPending} onClick={saveNote}>
              Save note
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setNote(source.note)
                onEdit(false)
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        source.note && <p className="mt-1 whitespace-pre-wrap pl-9 text-[12.5px] text-muted">{source.note}</p>
      )}
      <div className="mt-1.5 flex items-center gap-0.5 pl-8">
        <Button size="icon" variant="ghost" aria-label={`Move S${number} up`} title="Move up" disabled={first || m.reorder.isPending} onClick={() => onMove(-1)} icon={<ArrowUp className="h-3.5 w-3.5" />} />
        <Button size="icon" variant="ghost" aria-label={`Move S${number} down`} title="Move down" disabled={last || m.reorder.isPending} onClick={() => onMove(1)} icon={<ArrowDown className="h-3.5 w-3.5" />} />
        {!editing && (
          <Button size="sm" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => onEdit(true)}>
            {source.note ? 'Edit note' : 'Add a note'}
          </Button>
        )}
        <span className="flex-1" />
        {confirm ? (
          <>
            <Button size="sm" variant="danger" loading={m.removeSource.isPending} onClick={() => m.removeSource.mutate(source.id)}>
              Remove
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
              Keep
            </Button>
          </>
        ) : (
          <Button size="icon" variant="ghost" aria-label={`Remove S${number}`} title="Remove" onClick={() => setConfirm(true)} icon={<Trash2 className="h-3.5 w-3.5" />} />
        )}
      </div>
      {(m.updateSource.error || m.removeSource.error) && <p className="mt-1 pl-9 text-[12px] text-error">{problem(m.updateSource.error ?? m.removeSource.error)}</p>}
    </li>
  )
}

/** "Add to research" in the panel: this page or the selection, with an optional note. */
function AddSource({ sessionId }: { sessionId: string }) {
  const m = useResearchMutations(sessionId)
  const [note, setNote] = useState('')
  const add = (mode: 'page' | 'selection') => m.add.mutate({ mode, note }, { onSuccess: () => setNote('') })
  return (
    <Card>
      <CardBody className="flex flex-col gap-2">
        <Textarea aria-label="Note (optional)" placeholder="A note on why it matters (optional)" rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} loading={m.add.isPending && m.add.variables?.mode === 'page'} disabled={m.add.isPending} onClick={() => add('page')}>
            Add this page
          </Button>
          <Button size="sm" icon={<TextSelect className="h-3.5 w-3.5" />} loading={m.add.isPending && m.add.variables?.mode === 'selection'} disabled={m.add.isPending} onClick={() => add('selection')}>
            Add the selection
          </Button>
        </div>
        {m.add.error && <p className="text-[12px] text-error">{problem(m.add.error)}</p>}
        {m.add.isSuccess && !m.add.isPending && (
          <>
            <p className="text-[12px] text-muted">Added “{m.add.data.title}”.</p>
            <AlwaysAllow url={m.add.data.url} />
          </>
        )}
      </CardBody>
    </Card>
  )
}

function WriteUp({ session, onDone }: { session: SessionDetail; onDone: () => void }) {
  const m = useResearchMutations(session.id)
  const [shape, setShape] = useState<Shape>('notes')
  return (
    <Card>
      <CardHeader title="End & write up" description="Anemo writes a document from the sources, citing each claim with a link to its source." />
      <CardBody className="flex flex-col gap-2">
        <fieldset className="flex flex-col gap-1.5">
          <legend className="sr-only">Shape of the write-up</legend>
          {SHAPES.map((s) => (
            <label key={s.value} className={cn('flex cursor-pointer gap-2 rounded-control border px-3 py-2', shape === s.value ? 'border-accent bg-accent-soft/40' : 'border-border')}>
              <input type="radio" name="shape" value={s.value} checked={shape === s.value} onChange={() => setShape(s.value)} className="mt-0.5 accent-[var(--color-accent)]" />
              <span>
                <span className="block text-[13px] font-medium">{s.label}</span>
                <span className="block text-[12px] text-muted">{s.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="flex gap-2">
          <Button variant="primary" size="sm" loading={m.end.isPending} onClick={() => void m.end.mutateAsync(shape).then(onDone, () => undefined)}>
            End & write up
          </Button>
          <Button variant="ghost" size="sm" onClick={onDone}>
            Cancel
          </Button>
        </div>
        {m.end.error && <p className="text-[12px] text-error">{problem(m.end.error)}</p>}
      </CardBody>
    </Card>
  )
}

function WriteUpState({ session }: { session: SessionDetail }) {
  const { connection } = useSession()
  const m = useResearchMutations(session.id)
  if (session.writeup_status === 'writing') {
    return (
      <div className="flex items-center gap-2 text-[13px] text-muted" role="status">
        <Loader2 className="h-4 w-4 animate-spin text-accent" /> Writing it up… you can close the panel, it carries on.
      </div>
    )
  }
  if (session.writeup_status === 'failed') {
    return (
      <Notice
        tone="error"
        title="The write-up failed"
        actions={
          <Button size="sm" icon={<RotateCcw className="h-3.5 w-3.5" />} loading={m.end.isPending} onClick={() => m.end.mutate('notes')}>
            Try again (notes)
          </Button>
        }
      >
        {session.writeup_error ?? 'Something went wrong.'}
      </Notice>
    )
  }
  if (!session.writeup_document_id) return null
  return (
    <a
      className="inline-flex h-8 w-fit items-center gap-1.5 rounded-control bg-surface-2 px-3 text-[13px] hover:bg-surface-hover"
      href={`${connection.serverUrl}/documents/${session.writeup_document_id}`}
      target="_blank"
      rel="noopener noreferrer"
    >
      <ExternalLink className="h-3.5 w-3.5" /> Open the write-up
    </a>
  )
}

/** A note offered for what was just added from the menu or the shortcut. */
function JustAdded({ sources, onNote }: { sources: Source[]; onNote: (id: string) => void }) {
  const added = useStored('session', 'researchAdded').value
  const [openedAt] = useState(() => Date.now())
  if (!added || added.at < openedAt - 2 * 60_000 || !sources.some((s) => s.id === added.sourceId)) return null
  const dismiss = () => void storage.set('session', 'researchAdded', null)
  return (
    <Notice
      title={`Added “${added.title}”`}
      actions={
        <>
          <Button
            size="sm"
            icon={<Pencil className="h-3.5 w-3.5" />}
            onClick={() => {
              onNote(added.sourceId)
              dismiss()
            }}
          >
            Add a note
          </Button>
          <Button size="sm" variant="ghost" onClick={dismiss}>
            Dismiss
          </Button>
        </>
      }
    />
  )
}

function SessionView({ id, onOpenChat }: { id: string; onOpenChat: (conversationId: string) => void }) {
  const detail = useSessionDetail(id)
  const m = useResearchMutations(id)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [ending, setEnding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)

  if (detail.isPending) return <div className="p-3 text-[13px] text-muted">Loading…</div>
  if (detail.error || !detail.data) {
    return (
      <div className="p-3">
        <Notice tone="error" title="Couldn’t load the session" actions={<Button size="sm" onClick={() => open(null)}>All sessions</Button>}>
          {problem(detail.error)}
        </Notice>
      </div>
    )
  }
  const s = detail.data
  const sources = s.sources
  const move = (index: number, by: -1 | 1) => {
    const ids = sources.map((x) => x.id)
    const [item] = ids.splice(index, 1)
    ids.splice(index + by, 0, item)
    m.reorder.mutate(ids)
  }
  const statusError = m.setStatus.error ?? m.rename.error ?? m.conversation.error

  return (
    <div className="flex flex-col gap-3 p-3">
      <button type="button" onClick={() => open(null)} className="flex w-fit items-center gap-1 text-[12.5px] text-muted hover:text-text">
        <ArrowLeft className="h-3.5 w-3.5" /> All sessions
      </button>
      <div className="flex flex-col gap-1.5">
        {renaming !== null ? (
          <form
            className="flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault()
              if (renaming.trim()) m.rename.mutate(renaming.trim(), { onSuccess: () => setRenaming(null) })
            }}
          >
            <Input aria-label="Topic" value={renaming} maxLength={300} autoFocus onChange={(e) => setRenaming(e.target.value)} />
            <Button type="submit" size="sm" variant="primary" loading={m.rename.isPending}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
          </form>
        ) : (
          <div className="flex items-start gap-2">
            <h2 className="min-w-0 flex-1 text-[15px] font-semibold leading-snug">{s.topic}</h2>
            <Button size="icon" variant="ghost" aria-label="Rename" title="Rename" onClick={() => setRenaming(s.topic)} icon={<Pencil className="h-3.5 w-3.5" />} />
          </div>
        )}
        <div className="flex items-center gap-2 text-[12px] text-muted">
          <StatusPill status={s.status} />
          <span>
            {sources.length} {sources.length === 1 ? 'source' : 'sources'} · started {formatWhen(s.created_at)}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {s.status === 'active' && (
          <Button size="sm" icon={<Pause className="h-3.5 w-3.5" />} loading={m.setStatus.isPending} onClick={() => m.setStatus.mutate('paused')}>
            Pause
          </Button>
        )}
        {s.status === 'paused' && (
          <Button size="sm" variant="primary" icon={<Play className="h-3.5 w-3.5" />} loading={m.setStatus.isPending} onClick={() => m.setStatus.mutate('active')}>
            Resume
          </Button>
        )}
        {s.status === 'ended' && s.writeup_status !== 'writing' && (
          <Button size="sm" icon={<RotateCcw className="h-3.5 w-3.5" />} loading={m.setStatus.isPending} onClick={() => m.setStatus.mutate('active')}>
            Reopen
          </Button>
        )}
        <Button size="sm" icon={<MessageSquareText className="h-3.5 w-3.5" />} loading={m.conversation.isPending} onClick={() => void m.conversation.mutateAsync().then(onOpenChat, () => undefined)}>
          Chat about the sources
        </Button>
        {s.status !== 'ended' && !ending && (
          <Button size="sm" variant="ghost" icon={<FileText className="h-3.5 w-3.5" />} disabled={sources.length === 0} title={sources.length === 0 ? 'Add a source first' : undefined} onClick={() => setEnding(true)}>
            End & write up
          </Button>
        )}
      </div>
      {statusError && <p className="text-[12px] text-error">{problem(statusError)}</p>}

      {ending && s.status !== 'ended' && <WriteUp session={s} onDone={() => setEnding(false)} />}
      <WriteUpState session={s} />

      {s.status === 'active' && <AddSource sessionId={s.id} />}
      {s.status === 'paused' && <p className="text-[12px] text-muted">Resume the session to add sources.</p>}
      <JustAdded sources={sources} onNote={setEditing} />

      {sources.length === 0 ? (
        <p className="text-[13px] text-muted">No sources yet. Add the page you’re reading, or a selection from it.</p>
      ) : (
        <ol className="flex flex-col gap-1.5" aria-label="Sources">
          {sources.map((src, i) => (
            <SourceItem
              key={src.id}
              source={src}
              number={i + 1}
              sessionId={s.id}
              first={i === 0}
              last={i === sources.length - 1}
              editing={editing === src.id}
              onEdit={(on) => setEditing(on ? src.id : null)}
              onMove={(by) => move(i, by)}
            />
          ))}
        </ol>
      )}
      {m.reorder.error && <p className="text-[12px] text-error">{problem(m.reorder.error)}</p>}
    </div>
  )
}

export function ResearchView({ onOpenChat }: { onOpenChat: (conversationId: string) => void }) {
  useFollowResearchChanges()
  const sessions = useSessions()
  const choice = useStored('session', 'researchOpen')
  if (!choice.loaded || sessions.isPending) return <div className="p-3 text-[13px] text-muted">Loading…</div>
  if (sessions.error) {
    return (
      <div className="p-3">
        <Notice tone="error" title="Couldn’t load research sessions">{problem(sessions.error)}</Notice>
      </div>
    )
  }
  const list = sessions.data ?? []
  // Unset: the active session if there is one. Chosen: that session, or the list.
  const id = choice.value ? choice.value.sessionId : (list.find((s) => s.status === 'active')?.id ?? null)
  if (id) return <SessionView key={id} id={id} onOpenChat={onOpenChat} />
  return <SessionList sessions={list} />
}

/** Under the panel header while a session is active: what it is, and a quick way in. */
export function ResearchBar({ onOpen }: { onOpen: () => void }) {
  const active = useStored('session', 'researchActive').value
  if (!active) return null
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border bg-accent-soft/40 px-3 text-left text-[12px] text-accent hover:bg-accent-soft"
      title="Open the research session"
    >
      <FlaskConical className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">
        Research: <span className="font-medium">{active.topic}</span>
      </span>
    </button>
  )
}
