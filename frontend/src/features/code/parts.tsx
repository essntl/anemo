/** Small pieces of the Code page: the state badge, the todo checklist, the "trimmed" mark. */
import { useContext, useState } from 'react'
import { CheckCircle2, Circle, CircleDot, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { cn } from '@/lib/cn'
import { msg, t } from '@/lib/i18n'
import { JobContext } from './jobContext'
import { type CodeJobState, logPath } from './threads'
import type { Todo } from './timeline'

const STATE: Record<CodeJobState, { label: string; tone: 'accent' | 'success' | 'error' | 'neutral' | 'warning' }> = {
  running: { label: msg('Running'), tone: 'accent' },
  done: { label: msg('Done'), tone: 'success' },
  failed: { label: msg('Failed'), tone: 'error' },
  cancelled: { label: msg('Cancelled'), tone: 'neutral' },
  exited_without_result: { label: msg('Exited without result'), tone: 'warning' },
}

export function StateBadge({ state, className }: { state: CodeJobState; className?: string }) {
  const s = STATE[state] ?? STATE.done
  return (
    <Badge tone={s.tone} className={cn('shrink-0 gap-1', className)}>
      {state === 'running' && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
      {t(s.label)}
    </Badge>
  )
}


/** "trimmed": the event was shortened to be stored; a tap says where the full log is. */
export function TrimmedMark() {
  const view = useContext(JobContext)
  const [open, setOpen] = useState(false)
  return (
    <span className="inline-flex max-w-full flex-wrap items-baseline gap-x-1.5">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="rounded-full bg-warning/12 px-1.5 text-[10.5px] font-medium text-warning hover:bg-warning/20">
        {t('trimmed')}
      </button>
      {open && view && (
        <span className="min-w-0 text-[11.5px] text-muted [overflow-wrap:anywhere]">
          {t('Shortened to be stored. The full log is on the computer: {path}', { path: logPath(view.job.job_dir) })}
        </span>
      )}
    </span>
  )
}

/** A todo list (TodoWrite), each item with its state. */
export function TodoChecklist({ todos, running }: { todos: Todo[]; running: boolean }) {
  return (
    <ul className="space-y-1">
      {todos.map((todo, i) => {
        const Icon = todo.status === 'completed' ? CheckCircle2 : todo.status === 'in_progress' ? CircleDot : Circle
        const active = todo.status === 'in_progress'
        return (
          <li key={i} className="flex items-start gap-2 text-[13px]">
            <Icon aria-hidden="true" className={cn('mt-0.5 h-3.5 w-3.5 shrink-0',
              todo.status === 'completed' ? 'text-tool-ok' : active ? 'text-accent' : 'text-subtle',
              active && running && 'animate-pulse')} />
            <span className={cn('min-w-0 break-words', todo.status === 'completed' && 'text-muted line-through', active && 'font-medium')}>
              {active && running && todo.activeForm ? todo.activeForm : todo.content}
            </span>
            <span className="sr-only">
              {todo.status === 'completed' ? t('(completed)') : active ? t('(in progress)') : t('(pending)')}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
