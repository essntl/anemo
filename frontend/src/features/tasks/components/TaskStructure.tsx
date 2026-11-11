/**
 * The parts of the task editor that tie a task to its steps and to other tasks:
 * its checklist, its subtasks, and the tasks it waits on ("blocked by").
 */
import { type KeyboardEvent, type ReactNode, useRef, useState } from 'react'
import { Check, CheckSquare, ListChecks, ListTree, Lock, Plus, X } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Checkbox } from '@/components/ui/Checkbox'
import { Dialog } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { Lingering } from '@/components/ui/Lingering'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { STATUS_LABELS, type Task, useCreateTask } from '../api'
import { type ChecklistItem, blockerCandidates, checklistProgress, isOpen, newItem, subtasksOf, waitingOn } from '../relations'
import { useToggleDone } from '../useToggleDone'

const iconButton =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-hover hover:text-text pointer-coarse:h-10 pointer-coarse:w-10'

/** A small heading with an icon, like Attachments. */
function Heading({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5">
      <span className="text-muted [&>svg]:h-3.5 [&>svg]:w-3.5" aria-hidden>{icon}</span>
      <h3 className="flex-1 text-[13px] font-medium">{title}</h3>
      {children}
    </div>
  )
}

/**
 * The checklist: quick steps with a tick, edited in place. Enter in the last field
 * adds an item; Backspace in an empty item removes it. Saved with the task.
 */
export function ChecklistEditor({ items, onChange }: { items: ChecklistItem[]; onChange: (items: ChecklistItem[]) => void }) {
  const [draft, setDraft] = useState('')
  const addField = useRef<HTMLInputElement>(null)
  const progress = checklistProgress(items)

  const set = (id: string, patch: Partial<ChecklistItem>) => onChange(items.map((i) => (i.id === id ? { ...i, ...patch } : i)))
  const remove = (id: string) => onChange(items.filter((i) => i.id !== id))
  const add = () => {
    if (!draft.trim()) return
    onChange([...items, newItem(draft)])
    setDraft('')
  }
  const onItemKey = (e: KeyboardEvent<HTMLInputElement>, item: ChecklistItem) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      addField.current?.focus()
    } else if (e.key === 'Backspace' && item.text === '') {
      e.preventDefault()
      remove(item.id)
      addField.current?.focus()
    }
  }

  return (
    <section aria-label={t('Checklist')} className="shrink-0">
      {progress && (
        <div className="mb-1 flex items-center gap-1.5 text-[12px] text-muted">
          <ListChecks className="h-3.5 w-3.5" /> {t('Checklist')} <span className="tabular-nums">{progress.done}/{progress.total}</span>
        </div>
      )}
      <ul className="flex max-h-56 flex-col overflow-y-auto">
        {items.map((item) => (
          <li key={item.id} className="group flex items-center gap-2 rounded-control py-0.5 pr-1 hover:bg-surface-hover">
            <Checkbox checked={item.done} aria-label={t('Done: {item}', { item: item.text || t('item') })} onChange={(e) => set(item.id, { done: e.target.checked })} />
            <input value={item.text} maxLength={500} aria-label={t('Checklist item')}
              onChange={(e) => set(item.id, { text: e.target.value })} onKeyDown={(e) => onItemKey(e, item)}
              // An item emptied and left: it goes (the server refuses empty ones).
              onBlur={() => item.text.trim() === '' && remove(item.id)}
              className={cn('h-7 min-w-0 flex-1 bg-transparent text-[13.5px] focus:outline-none', item.done && 'text-muted line-through')} />
            <button type="button" aria-label={t('Remove “{title}”', { title: item.text })} title={t('Remove')} onClick={() => remove(item.id)}
              className={cn(iconButton, 'h-6 w-6 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100')}>
              <X className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2 py-0.5">
        <Plus className="mx-[1px] h-4 w-4 shrink-0 text-subtle" />
        <input ref={addField} value={draft} maxLength={500} placeholder={items.length ? t('Add an item') : t('Add a checklist item')}
          aria-label={t('Add a checklist item')} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
          onBlur={add}
          className="h-7 min-w-0 flex-1 bg-transparent text-[13.5px] placeholder:text-subtle focus:outline-none" />
      </div>
    </section>
  )
}

/** A round tick like the list's, to complete or reopen a task at once. */
function DoneButton({ task }: { task: Task }) {
  const { toggle } = useToggleDone()
  const done = task.status === 'done'
  return (
    <button type="button" role="checkbox" aria-checked={done} aria-label={done ? t('Reopen “{title}”', { title: task.title }) : t('Complete “{title}”', { title: task.title })}
      onClick={() => void toggle(task)}
      className={cn('flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-2 transition-colors pointer-coarse:h-6 pointer-coarse:w-6',
        done ? 'border-success bg-success text-white' : 'border-border-strong hover:border-accent')}>
      {done && <Check className="h-3 w-3" strokeWidth={3} />}
    </button>
  )
}

/** One task in a list of related tasks: its title opens it. */
function RelatedTask({ task, onOpen, children }: { task: Task; onOpen?: (task: Task) => void; children?: ReactNode }) {
  const finished = !isOpen(task)
  return (
    <li className="group flex items-center gap-2 rounded-control px-1 py-1 hover:bg-surface-hover">
      {children}
      <button type="button" disabled={!onOpen} onClick={() => onOpen?.(task)} title={onOpen ? t('Open') : undefined}
        className={cn('min-w-0 flex-1 truncate text-left text-[13px] enabled:hover:text-accent', finished && 'text-muted line-through')}>
        {task.title}
      </button>
    </li>
  )
}

/**
 * The subtasks of a task: tick them off, open them, or add one (it gets the task's
 * project and tags). They are tasks of their own, saved at once.
 */
export function SubtaskList({ task, all, projectId, tags, onOpen }: {
  task: Task | null
  all: Task[]
  projectId: string | null
  tags: string[]
  onOpen?: (task: Task) => void
}) {
  const create = useCreateTask()
  const [draft, setDraft] = useState('')
  const subtasks = task ? subtasksOf(all, task.id) : []
  const done = subtasks.filter((t) => t.status === 'done').length
  const add = () => {
    const title = draft.trim()
    if (!title || !task) return
    create.mutate({ title, parent_id: task.id, project_id: projectId, tags }, { onSuccess: () => setDraft('') })
  }

  return (
    <section aria-label={t('Subtasks')}>
      <Heading icon={<ListTree />} title={t('Subtasks')}>
        {subtasks.length > 0 && <span className="text-[12px] tabular-nums text-muted">{done}/{subtasks.length}</span>}
      </Heading>
      {!task ? (
        <p className="text-[12.5px] text-muted">{t('Add the task first, then add subtasks to it.')}</p>
      ) : (
        <>
          <ul className="flex flex-col">
            {subtasks.map((sub) => (
              <RelatedTask key={sub.id} task={sub} onOpen={onOpen}><DoneButton task={sub} /></RelatedTask>
            ))}
          </ul>
          <div className="flex items-center gap-2 px-1 py-0.5">
            <Plus className="h-4 w-4 shrink-0 text-subtle" />
            <input value={draft} maxLength={300} placeholder={t('Add a subtask')} aria-label={t('Add a subtask')}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  add()
                }
              }}
              className="h-7 min-w-0 flex-1 bg-transparent text-[13px] placeholder:text-subtle focus:outline-none" />
          </div>
          {create.error && <p className="text-[12.5px] text-error">{errorMessage(create.error)}</p>}
        </>
      )}
    </section>
  )
}

/**
 * What the task waits on (chosen here, saved with the task) and, below, what waits on
 * it. While any task it waits on is open, it is blocked.
 */
export function BlockedByEditor({ task, all, blockedBy, onChange, onOpen }: {
  task: Task | null
  all: Task[]
  blockedBy: string[]
  onChange: (ids: string[]) => void
  onOpen?: (task: Task) => void
}) {
  const [picking, setPicking] = useState(false)
  const tasks = new Map(all.map((t) => [t.id, t]))
  const chosen = blockedBy.map((id) => tasks.get(id)).filter((t): t is Task => t !== undefined)
  const blocks = task ? waitingOn(all, task.id) : []
  const stillOpen = chosen.filter(isOpen).length

  return (
    <section aria-label={t('Waits on')}>
      <Heading icon={<Lock />} title={t('Waits on')}>
        <button type="button" aria-label={t('Choose a task it waits on')} title={t('Choose a task it waits on')} onClick={() => setPicking(true)} className={iconButton}>
          <Plus className="h-4 w-4" />
        </button>
      </Heading>
      {chosen.length === 0 ? (
        <p className="text-[12.5px] text-muted">{t('Nothing. Add the tasks that have to be done first.')}</p>
      ) : (
        <>
          <ul className="flex flex-col">
            {chosen.map((other) => (
              <RelatedTask key={other.id} task={other} onOpen={onOpen}>
                <span className={cn('h-2 w-2 shrink-0 rounded-full', isOpen(other) ? 'bg-warning' : 'bg-success')}
                  title={t(STATUS_LABELS[other.status])} aria-label={t(STATUS_LABELS[other.status])} />
                <button type="button" aria-label={t('Stop waiting on “{title}”', { title: other.title })} title={t('Remove')}
                  onClick={() => onChange(blockedBy.filter((id) => id !== other.id))}
                  className={cn(iconButton, 'order-last h-6 w-6 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100')}>
                  <X className="h-3.5 w-3.5" />
                </button>
              </RelatedTask>
            ))}
          </ul>
          <p className="mt-0.5 text-[12px] text-muted">
            {stillOpen ? t('Blocked while any of these is open.') : t('All done: nothing blocks it.')}
          </p>
        </>
      )}
      {blocks.length > 0 && (
        <div className="mt-3">
          <h4 className="mb-1 text-[12px] font-medium text-muted">{t('Blocks')}</h4>
          <ul className="flex flex-col">
            {blocks.map((t) => <RelatedTask key={t.id} task={t} onOpen={onOpen} />)}
          </ul>
        </div>
      )}
      <Lingering value={picking || null}>
        {() => (
          <TaskPickerDialog title={t('Waits on')} description={t('The task is blocked while any task it waits on is open.')}
            tasks={blockerCandidates(all, task?.id ?? null, blockedBy)}
            onPick={(t) => onChange([...blockedBy, t.id])} onClose={() => setPicking(false)} />
        )}
      </Lingering>
    </section>
  )
}

const MAX_SHOWN = 60 // search narrows it down

/** Pick one task from a list, with a search box. */
export function TaskPickerDialog({ title, description, tasks, onPick, onClose }: {
  title: string
  description?: string
  tasks: Task[]
  onPick: (task: Task) => void
  onClose: () => void
}) {
  const [search, setSearch] = useState('')
  const q = search.trim().toLowerCase()
  const shown = tasks.filter((t) => !q || t.title.toLowerCase().includes(q)).slice(0, MAX_SHOWN)
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={title} description={description} className="md:w-[min(92vw,480px)]">
      <Input value={search} autoFocus placeholder={t('Search tasks…')} aria-label={t('Search tasks')} onChange={(e) => setSearch(e.target.value)} />
      <ul className="mt-3 max-h-[45dvh] overflow-y-auto rounded-control border border-border" role="listbox" aria-label={title}>
        {shown.length === 0 && <li className="p-4 text-[13px] text-muted">{tasks.length ? t('Nothing matches.') : t('No other tasks to choose.')}</li>}
        {shown.map((task) => (
          <li key={task.id}>
            <button type="button" role="option" aria-selected={false}
              onClick={() => {
                onPick(task)
                onClose()
              }}
              className="flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left last:border-b-0 hover:bg-surface-hover">
              <CheckSquare className="h-4 w-4 shrink-0 text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium">{task.title}</span>
                <span className="block truncate text-[11.5px] text-muted">{t(STATUS_LABELS[task.status])}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  )
}
