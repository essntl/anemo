/**
 * Tasks: a list grouped by when things are due, or a board by status.
 * View and filters are kept in the URL (?view=board&project=…&tag=…).
 */
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { CheckSquare, ChevronRight, FolderKanban, KanbanSquare, List, Plus } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Select } from '@/components/ui/Select'
import { cn } from '@/lib/cn'
import { type Project, type Task, type TaskStatus, useCreateTask, useProjects, useTasks } from './api'
import { ProjectsDialog } from './components/ProjectsDialog'
import { TaskBoard } from './components/TaskBoard'
import { TaskDialog } from './components/TaskDialog'
import { TaskRow } from './components/TaskRow'
import { type Bucket, BUCKET_LABELS, bucketOf } from './dates'

const BUCKETS: Bucket[] = ['overdue', 'today', 'upcoming', 'later', 'none']

/** Open tasks in the order they matter: earliest due first, then by priority. */
function byUrgency(a: Task, b: Task): number {
  return (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999')
    || (a.due_time ?? '99').localeCompare(b.due_time ?? '99')
    || b.priority - a.priority
    || a.sort_order - b.sort_order
}

type Editing = { task: Task | null; status?: TaskStatus } | null

export function TasksPage() {
  const [params, setParams] = useSearchParams()
  const view = params.get('view') === 'board' ? 'board' : 'list'
  const projectFilter = params.get('project') ?? ''
  const tagFilter = params.get('tag') ?? ''
  const tasks = useTasks()
  const projects = useProjects()
  const create = useCreateTask()
  const [quick, setQuick] = useState('')
  const [search, setSearch] = useState('')
  const [showDone, setShowDone] = useState(false)
  const [chosen, setEditing] = useState<Editing>(null)
  const [projectsOpen, setProjectsOpen] = useState(false)

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next, { replace: true })
  }

  const projectMap = useMemo(() => new Map<string, Project>((projects.data ?? []).map((p) => [p.id, p])), [projects.data])
  const all = useMemo(() => tasks.data ?? [], [tasks.data])
  // A link to one task (/tasks?task=<id>, e.g. from search) opens it.
  const linked = all.find((t) => t.id === params.get('task'))
  const editing: Editing = chosen ?? (linked ? { task: linked } : null)
  const tags = useMemo(() => [...new Set(all.flatMap((t) => t.tags))].sort(), [all])
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return all.filter(
      (t) =>
        (!projectFilter || t.project_id === projectFilter) &&
        (!tagFilter || t.tags.includes(tagFilter)) &&
        (!q || t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)),
    )
  }, [all, projectFilter, tagFilter, search])
  const open = shown.filter((t) => t.status !== 'done' && t.status !== 'cancelled').sort(byUrgency)
  const finished = shown
    .filter((t) => t.status === 'done' || t.status === 'cancelled')
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))

  const quickAdd = () => {
    const title = quick.trim()
    if (!title) return
    create.mutate({ title, project_id: projectFilter || null }, { onSuccess: () => setQuick('') })
  }

  return (
    <div className={cn('mx-auto p-4 md:p-8', view === 'board' ? 'max-w-none' : 'max-w-3xl')}>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <CheckSquare className="h-5 w-5" />
        </div>
        <h1 className="min-w-0 flex-1 text-xl font-semibold">Tasks</h1>
        <div className="inline-flex rounded-lg bg-surface-2 p-0.5" role="radiogroup" aria-label="View">
          {([['list', 'List', List], ['board', 'Board', KanbanSquare]] as const).map(([id, label, Icon]) => (
            <button key={id} type="button" role="radio" aria-checked={view === id} onClick={() => setParam('view', id === 'list' ? '' : id)}
              className={cn('flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium pointer-coarse:h-10',
                view === id ? 'bg-surface text-text shadow-soft' : 'text-muted hover:text-text')}>
              <Icon className="h-3.5 w-3.5" /> {label}
            </button>
          ))}
        </div>
        <Button size="sm" variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({ task: null })}>
          New task
        </Button>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search" aria-label="Search tasks"
          className="h-9 min-w-32 flex-1 rounded-control border border-border bg-surface px-3 text-[13px] focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft pointer-coarse:h-10" />
        <Select className="h-9 w-full sm:w-44" aria-label="Project" value={projectFilter} onValueChange={(v) => setParam('project', v)}
          options={[{ value: '', label: 'All projects' }, ...(projects.data ?? []).filter((p) => !p.archived).map((p) => ({ value: p.id, label: p.name }))]} />
        {tags.length > 0 && (
          <Select className="h-9 w-full sm:w-36" aria-label="Tag" value={tagFilter} onValueChange={(v) => setParam('tag', v)}
            options={[{ value: '', label: 'All tags' }, ...tags.map((t) => ({ value: t, label: `#${t}` }))]} />
        )}
        <Button size="sm" variant="ghost" icon={<FolderKanban className="h-3.5 w-3.5" />} onClick={() => setProjectsOpen(true)}>
          Projects
        </Button>
      </div>

      {(tasks.error ?? create.error) && <p className="mb-2 text-[13px] text-error">{errorMessage(tasks.error ?? create.error)}</p>}

      {view === 'board' ? (
        <TaskBoard tasks={shown} projects={projectMap} onOpen={(task) => setEditing({ task })}
          onAdd={(status) => setEditing({ task: null, status })} />
      ) : (
        <>
          <div className="mb-4 flex items-center gap-2 rounded-card border border-border bg-card px-3 py-1.5 shadow-soft">
            <Plus className="h-4 w-4 shrink-0 text-muted" />
            <input value={quick} onChange={(e) => setQuick(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && quickAdd()}
              placeholder="Add a task and press Enter" aria-label="Add a task"
              className="h-9 min-w-0 flex-1 bg-transparent text-[14px] placeholder:text-subtle focus:outline-none" />
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
                  <TaskRow key={t.id} task={t} project={t.project_id ? projectMap.get(t.project_id) : undefined}
                    onOpen={(task) => setEditing({ task })} />
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
                <TaskRow key={t.id} task={t} project={t.project_id ? projectMap.get(t.project_id) : undefined}
                  onOpen={(task) => setEditing({ task })} />
              ))}
            </section>
          )}
        </>
      )}

      {editing && (
        <TaskDialog task={editing.task} onClose={() => { setEditing(null); setParam('task', '') }}
          defaults={{ status: editing.status, project_id: projectFilter || null }} />
      )}
      {projectsOpen && <ProjectsDialog onClose={() => setProjectsOpen(false)} />}
    </div>
  )
}
