import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { Link } from 'react-router'
import { Check, ChevronDown, Search, SquareCheckBig, Target, X } from 'lucide-react'
import { useCurrentProject } from '@/app/projectStore'
import { cn } from '@/lib/cn'
import { useTasks } from '@/features/tasks/api'
import { matchTasks } from '../taskMatch'
import { timerActions, useTimerStore } from '../timerStore'

/**
 * Which task the timer is for: a chip with the task (opens it in Tasks; × unlinks it)
 * and a searchable list of open tasks to pick another.
 */
export function TaskPicker({ className }: { className?: string }) {
  const taskId = useTimerStore((s) => s.timer.taskId)
  const tasks = useTasks()
  const project = useCurrentProject()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const list = useRef<HTMLUListElement>(null)
  const linked = tasks.data?.find((t) => t.id === taskId) ?? null
  const matches = useMemo(() => matchTasks(tasks.data ?? [], query, project?.id ?? null).slice(0, 50), [tasks.data, query, project?.id])

  const choose = (id: string | null) => {
    timerActions.setTask(id)
    setOpen(false)
    setQuery('')
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = Math.max(0, Math.min(matches.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)))
      setActive(next)
      list.current?.children[next]?.scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'Enter' && matches[active]) {
      e.preventDefault()
      choose(matches[active].id)
    }
  }

  return (
    <div className={cn('flex min-w-0 items-center gap-1.5', className)}>
      {linked ? (
        <span className="flex min-w-0 items-center gap-1 rounded-full border border-border bg-surface-2 py-1 pl-2.5 pr-1 text-[13px]">
          <SquareCheckBig className="h-3.5 w-3.5 shrink-0 text-accent" />
          <Link to={`/tasks?task=${linked.id}`} className="min-w-0 truncate font-medium hover:underline">{linked.title}</Link>
          <button type="button" aria-label="Stop linking this task" onClick={() => choose(null)}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-hover hover:text-text pointer-coarse:h-8 pointer-coarse:w-8">
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      ) : null}
      <Popover.Root open={open} onOpenChange={(o) => { setOpen(o); setActive(0) }}>
        <Popover.Trigger asChild>
          <button type="button"
            className={cn('flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-muted hover:bg-surface-hover hover:text-text pointer-coarse:h-10',
              !linked && 'border border-dashed border-border-strong')}>
            {linked ? <>Change <ChevronDown className="h-3.5 w-3.5" /></> : <><Target className="h-4 w-4" /> Link a task</>}
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content align="start" sideOffset={6} collisionPadding={12}
            className="pop z-50 w-[min(22rem,calc(100vw-24px))] rounded-card border border-border bg-card p-1.5 shadow-float">
            <div className="flex items-center gap-2 border-b border-border px-2 pb-1.5">
              <Search className="h-4 w-4 shrink-0 text-muted" />
              <input autoFocus value={query} onChange={(e) => { setQuery(e.target.value); setActive(0) }} onKeyDown={onKeyDown}
                placeholder="Find a task" aria-label="Find a task" role="combobox" aria-expanded aria-controls="focus-task-list"
                aria-activedescendant={matches[active] ? `focus-task-${matches[active].id}` : undefined}
                className="h-9 min-w-0 flex-1 bg-transparent text-[14px] placeholder:text-subtle focus:outline-none" />
            </div>
            <ul ref={list} id="focus-task-list" role="listbox" aria-label="Open tasks" className="max-h-72 overflow-y-auto py-1">
              {matches.map((t, i) => (
                <li key={t.id} id={`focus-task-${t.id}`} role="option" aria-selected={t.id === taskId}
                  onMouseEnter={() => setActive(i)} onClick={() => choose(t.id)}
                  className={cn('flex cursor-pointer items-center gap-2 rounded-control px-2.5 py-2 text-[13.5px] pointer-coarse:py-3',
                    i === active && 'bg-surface-hover')}>
                  <span className="min-w-0 flex-1 truncate">{t.title}</span>
                  {t.id === taskId && <Check className="h-4 w-4 shrink-0 text-accent" />}
                </li>
              ))}
              {tasks.isSuccess && matches.length === 0 && (
                <li className="px-2.5 py-3 text-[13px] text-muted">
                  {query ? 'No open task matches.' : 'No open tasks. Add some in Tasks to track time per task.'}
                </li>
              )}
            </ul>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  )
}
