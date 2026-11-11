/**
 * Tasks: a list grouped by when things are due, or a board by status.
 * View and tag filter are kept in the URL (?view=board&tag=…); the project filter is
 * the project chosen in the sidebar (changing it here changes it everywhere).
 *
 * A link to a task (/tasks?task=<id>: from a document, another task's notes, search)
 * shows it in the list: scrolled to, marked for a moment and with its notes open. It
 * does not open the editor; a click on the task does.
 */
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { CheckSquare, ChevronRight, KanbanSquare, List, Plus, Trash2 } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { inScope, useProjectStore, useScope } from '@/app/projectStore'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Select } from '@/components/ui/Select'
import { DESKTOP, useMediaQuery } from '@/hooks/useMediaQuery'
import { cn } from '@/lib/cn'
import { PRIORITY_LABELS, type Project, type Task, type TaskStatus, useCreateTask, useProjects, useTasks } from './api'
import { TaskBoard } from './components/TaskBoard'
import { TaskDialog } from './components/TaskDialog'
import { ItemTrashDialog } from '@/features/trash/ItemTrashDialog'
import { type TaskInfo, TaskRow } from './components/TaskRow'
import { type Bucket, BUCKET_LABELS, bucketOf, formatDay } from './dates'
import { parseQuickAdd } from './quickAdd'
import { byId } from './relations'
import { Lingering } from '@/components/ui/Lingering'
import { PageHeader } from '@/components/ui/PageHeader'

const BUCKETS: Bucket[] = ['overdue', 'today', 'upcoming', 'later', 'none']

/** Open tasks in the order they matter: earliest due first, then by priority. */
function byUrgency(a: Task, b: Task): number {
  return (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999')
    || (a.due_time ?? '99').localeCompare(b.due_time ?? '99')
    || b.priority - a.priority
    || a.sort_order - b.sort_order
}

/** From this width a task opens in a panel beside the list. */
const VERY_WIDE = '(min-width: 1440px)'

const QUICK_CHIP = "shrink-0 rounded-md bg-accent-soft px-2 py-0.5 text-[12px] font-medium text-accent"

/** The task editor: an existing task, or a new one starting in a status. */
type Editing = { task: Task | null; status?: TaskStatus } | null

export function TasksPage() {
  const [params, setParams] = useSearchParams()
  const view = params.get('view') === 'board' ? 'board' : 'list'
  // What the sidebar's switcher shows: the tasks of no project, of one project, or all.
  const scope = useScope()
  const projectFilter = scope.kind === 'project' ? scope.project.id : ''
  const setView = useProjectStore((s) => s.setView)
  const tagFilter = params.get('tag') ?? ''
  const tasks = useTasks()
  const projects = useProjects()
  const create = useCreateTask()
  const [quick, setQuick] = useState('')
  const [search, setSearch] = useState('')
  const [showDone, setShowDone] = useState(false)
  const [editing, setEditing] = useState<Editing>(null)
  const [trashOpen, setTrashOpen] = useState(false)
  // Tasks whose notes are shown in the list.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const toggleNotes = (id: string) =>
    setExpanded((old) => {
      const next = new Set(old)
      if (!next.delete(id)) next.add(id)
      return next
    })

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next, { replace: true })
  }

  const projectMap = useMemo(() => new Map<string, Project>((projects.data ?? []).map((p) => [p.id, p])), [projects.data])
  const all = useMemo(() => tasks.data ?? [], [tasks.data])
  const info = useMemo<TaskInfo>(() => ({ all, byId: byId(all) }), [all])
  // The task a link points to. It is made visible whatever the list was showing:
  // its notes opened, "Finished" unfolded, the search emptied (here, once per link),
  // and filters or the board view that would hide it dropped (the effect below).
  const linked = all.find((t) => t.id === params.get('task'))
  const [revealed, setRevealed] = useState<string | null>(null)
  if (linked && revealed !== linked.id) {
    setRevealed(linked.id)
    setExpanded((old) => new Set(old).add(linked.id))
    setSearch('')
    // A finished task is under "Finished", unless it is a subtask of an open task.
    const parent = linked.parent_id ? all.find((t) => t.id === linked.parent_id) : undefined
    const underOpenParent = parent !== undefined && parent.status !== 'done' && parent.status !== 'cancelled'
    if ((linked.status === 'done' || linked.status === 'cancelled') && !underOpenParent) setShowDone(true)
  }
  useEffect(() => {
    if (!linked) return
    if (!inScope(scope, linked.project_id)) setView('all')
    const hiddenByTag = tagFilter !== '' && !linked.tags.includes(tagFilter)
    if (hiddenByTag || view === 'board') {
      const next = new URLSearchParams(params)
      next.delete('view')
      if (hiddenByTag) next.delete('tag')
      setParams(next, { replace: true })
    }
    // Only when a link arrives; afterwards filters and views are the user's again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked?.id])
  const tags = useMemo(() => [...new Set(all.flatMap((t) => t.tags))].sort(), [all])
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return all.filter(
      (t) =>
        inScope(scope, t.project_id) &&
        (!tagFilter || t.tags.includes(tagFilter)) &&
        (!q || t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)),
    )
  }, [all, scope, tagFilter, search])
  // Open tasks the switcher keeps out of sight, so they are not forgotten.
  const elsewhere = scope.kind === 'all' ? 0 : all.filter((t) => t.status !== 'done' && t.status !== 'cancelled' && !inScope(scope, t.project_id)).length
  const openShown = shown.filter((t) => t.status !== 'done' && t.status !== 'cancelled')
  // A subtask whose parent is in the list is shown folded in under it, not on its own.
  const listedParents = new Set(openShown.map((t) => t.id))
  const onItsOwn = (t: Task) => t.parent_id === null || !listedParents.has(t.parent_id)
  const open = openShown.filter(onItsOwn).sort(byUrgency)
  const finished = shown
    .filter((t) => (t.status === 'done' || t.status === 'cancelled') && onItsOwn(t))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))

  const understood = parseQuickAdd(quick)
  const quickAdd = () => {
    if (!quick.trim()) return
    // A day, a priority and tags typed at the end are taken off the title (quickAdd.ts).
    const { title, due_date, priority, tags } = parseQuickAdd(quick)
    create.mutate({ title, due_date, priority, tags, project_id: projectFilter || null }, { onSuccess: () => setQuick('') })
  }

  // Very wide screens: a task opens beside the list (not over it), so the list stays in reach.
  const beside = useMediaQuery(VERY_WIDE) && view === 'list'
  const desktop = useMediaQuery(DESKTOP)
  return (
    <div className="flex h-full">
    <div className="min-w-0 flex-1 overflow-y-auto">
    <div className={cn('mx-auto p-4 md:px-8 md:pb-8 md:pt-2', view === 'board' ? 'max-w-none' : 'max-w-3xl')}>
      <PageHeader title="Tasks">
        {/* On a phone the Trash is beside the view switch below: up here it ran under the Dynamic Island. */}
        {desktop && <Button size="sm" variant="ghost" className="shrink-0" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setTrashOpen(true)}>Trash</Button>}
        <Button size="sm" variant="primary" className="shrink-0" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({ task: null })}>
          New task
        </Button>
      </PageHeader>

      {/* Search and the view switch share one line; the filters are small pills below. */}
      <div className="mb-2 flex items-center gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search" aria-label="Search tasks"
          className="h-9 min-w-0 flex-1 rounded-control border border-border bg-surface px-3 text-[13px] focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft pointer-coarse:h-10" />
        <div className="inline-flex shrink-0 rounded-lg bg-surface-2 p-0.5" role="radiogroup" aria-label="View">
          {([['list', 'List', List], ['board', 'Board', KanbanSquare]] as const).map(([id, label, Icon]) => (
            <button key={id} type="button" role="radio" aria-checked={view === id} title={label} onClick={() => setParam('view', id === 'list' ? '' : id)}
              className={cn('relative flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium pointer-coarse:h-9 pointer-coarse:px-3',
                view === id ? 'bg-surface text-text shadow-soft' : 'text-muted hover:text-text')}>
              {/* On a phone just the icon; the name stays for screen readers. */}
              <Icon className="h-4 w-4 sm:h-3.5 sm:w-3.5" /> <span className="max-sm:sr-only">{label}</span>
            </button>
          ))}
        </div>
        {!desktop && (
          <Button size="icon" variant="ghost" className="-ml-1 shrink-0" aria-label="Trash" title="Deleted tasks" onClick={() => setTrashOpen(true)}>
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {tags.length > 0 && (
          <Select variant="pill" aria-label="Tag" value={tagFilter} onValueChange={(v) => setParam('tag', v)}
            options={[{ value: '', label: 'All tags' }, ...tags.map((t) => ({ value: t, label: `#${t}` }))]} />
        )}
      </div>

      {(tasks.error ?? create.error) && <p className="mb-2 text-[13px] text-error">{errorMessage(tasks.error ?? create.error)}</p>}

      {view === 'board' ? (
        <TaskBoard tasks={shown} info={info} projects={projectMap} onOpen={(task) => setEditing({ task })}
          onAdd={(status) => setEditing({ task: null, status })} />
      ) : (
        <>
          <div className="mb-4 flex items-center gap-2 rounded-card border border-border bg-card px-3 py-1.5 shadow-soft">
            <Plus className="h-4 w-4 shrink-0 text-muted" />
            <input value={quick} onChange={(e) => setQuick(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && quickAdd()}
              placeholder="Add a task: “Call the bank fri !high #errands”" aria-label="Add a task"
              className="h-9 min-w-0 flex-1 bg-transparent text-[14px] placeholder:text-subtle focus:outline-none" />
            {/* What was understood from the end of the text, before it is added. */}
            {understood.due_date && <span className={QUICK_CHIP}>{formatDay(understood.due_date)}</span>}
            {understood.priority > 0 && <span className={QUICK_CHIP}>{PRIORITY_LABELS[understood.priority]}</span>}
            {understood.tags.map((t) => <span key={t} className={QUICK_CHIP}>#{t}</span>)}
            {quick.trim() && <Button size="sm" variant="primary" loading={create.isPending} onClick={quickAdd}>Add</Button>}
          </div>

          {tasks.isSuccess && all.length === 0 && (
            <EmptyState icon={<CheckSquare className="h-5 w-5" />} title="No tasks yet"
              description="Add one above, or ask an agent: “remind me to renew my passport next Friday”." />
          )}
          {BUCKETS.map((bucket) => {
            const items = open.filter((t) => bucketOf(t) === bucket)
            if (!items.length) return null
            return (
              <section key={bucket} className="mb-4">
                <h2 className={cn('mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider', bucket === 'overdue' ? 'text-error' : 'text-subtle')}>
                  {BUCKET_LABELS[bucket]} <span className="font-normal">{items.length}</span>
                </h2>
                {items.map((t) => (
                  <TaskRow key={t.id} task={t} projects={projectMap} info={info} onOpen={(task) => setEditing({ task })}
                    notesShown={(id) => expanded.has(id)} onToggleNotes={toggleNotes} linkedId={linked?.id} />
                ))}
              </section>
            )
          })}
          {finished.length > 0 && (
            <section className="mb-4">
              <button type="button" onClick={() => setShowDone(!showDone)} aria-expanded={showDone}
                className="mb-1 flex items-center gap-1 rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-subtle hover:text-text">
                <ChevronRight className={cn('h-3 w-3 transition-transform', showDone && 'rotate-90')} />
                Finished <span className="font-normal">{finished.length}</span>
              </button>
              {showDone && finished.slice(0, 100).map((t) => (
                <TaskRow key={t.id} task={t} projects={projectMap} info={info} onOpen={(task) => setEditing({ task })}
                  notesShown={(id) => expanded.has(id)} onToggleNotes={toggleNotes} linkedId={linked?.id} />
              ))}
            </section>
          )}
        </>
      )}

      {elsewhere > 0 && (
        <p className="mt-2 flex items-center gap-2 rounded-control bg-surface-2 px-3 py-2 text-[12.5px] text-muted">
          <span className="min-w-0 flex-1">
            {elsewhere === 1 ? '1 more open task is' : `${elsewhere} more open tasks are`}{' '}
            {scope.kind !== 'uncategorized' ? 'outside this project' : elsewhere === 1 ? 'filed in a project' : 'filed in projects'}.
          </span>
          <button type="button" onClick={() => setView('all')} className="shrink-0 font-medium text-accent hover:underline">Show all</button>
        </p>
      )}

      <Lingering value={beside ? null : editing}>
        {(shown) => (
          <TaskDialog key={shown.task?.id ?? 'new'} task={shown.task} onClose={() => setEditing(null)}
            onOpenTask={(task) => setEditing({ task })}
            defaults={{ status: shown.status, project_id: projectFilter || null }} />
        )}
      </Lingering>
      <ItemTrashDialog kind="task" open={trashOpen} onOpenChange={setTrashOpen} />
    </div>
    </div>
    {beside && editing && (
      <div className="h-full shrink-0 pb-3 pr-3">
        <TaskDialog panel key={editing.task?.id ?? 'new'} task={editing.task} onClose={() => setEditing(null)}
          onOpenTask={(task) => setEditing({ task })}
          defaults={{ status: editing.status, project_id: projectFilter || null }} />
      </div>
    )}
    </div>
  )
}
