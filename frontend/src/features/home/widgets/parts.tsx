import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { ArrowUpRight, Check, Plus } from 'lucide-react'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import type { Task } from '@/features/tasks/api'
import { bucketOf, formatDue } from '@/features/tasks/dates'
import { useToggleDone } from '@/features/tasks/useToggleDone'

/** A widget's title row: icon, name, extra bits, and ↗ to its full page. */
export function WidgetHeader({ title, icon, to, children }: { title: string; icon: ReactNode; to?: string; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-4 pb-2 pt-3.5">
      <span className="text-muted [&>svg]:h-4 [&>svg]:w-4" aria-hidden>{icon}</span>
      <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold">{title}</h2>
      {children}
      {to && (
        <Link to={to} aria-label={t('Open {title}', { title })} title={t('Open {title}', { title })}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-hover hover:text-text pointer-coarse:h-10 pointer-coarse:w-10">
          <ArrowUpRight className="h-4 w-4" />
        </Link>
      )}
    </div>
  )
}

/** A task with a check box that completes it; the title opens it in Tasks. */
export function TaskLine({ task, showDue = true }: { task: Task; showDue?: boolean }) {
  const { toggle } = useToggleDone()
  const done = task.status === 'done'
  const overdue = !done && bucketOf(task) === 'overdue'
  return (
    <li className="flex items-center gap-2.5 rounded-control px-2 py-1.5 hover:bg-surface-hover">
      <button type="button" role="checkbox" aria-checked={done} aria-label={done ? t('Reopen “{title}”', { title: task.title }) : t('Complete “{title}”', { title: task.title })}
        onClick={() => void toggle(task)}
        className={cn('flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-2 transition-colors pointer-coarse:h-6 pointer-coarse:w-6',
          done ? 'border-success bg-success text-white' : overdue ? 'border-error hover:border-error' : 'border-border-strong hover:border-accent')}>
        {done && <Check className="h-3 w-3" strokeWidth={3} />}
      </button>
      <Link to={`/tasks?task=${task.id}`} className={cn('min-w-0 flex-1 truncate text-[13.5px] hover:text-accent', done && 'text-muted line-through')}>
        {task.title}
      </Link>
      {showDue && task.due_date && (
        <span className={cn('shrink-0 text-[11.5px] tabular-nums', overdue ? 'font-medium text-error' : 'text-muted')}>
          {overdue ? t('Overdue') : formatDue(task)}
        </span>
      )}
    </li>
  )
}

/** A one-line "add …" field (Enter adds). */
export function QuickAdd({ placeholder, onAdd, busy }: { placeholder: string; onAdd: (text: string) => Promise<unknown> | void; busy?: boolean }) {
  const [text, setText] = useState('')
  return (
    <form className="mb-1.5 flex items-center gap-2 rounded-control bg-surface-2 px-3"
      onSubmit={(e) => {
        e.preventDefault()
        const t = text.trim()
        if (!t || busy) return
        void Promise.resolve(onAdd(t)).then(() => setText(''))
      }}>
      <Plus className="h-4 w-4 shrink-0 text-muted" />
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} aria-label={placeholder}
        className="h-9 min-w-0 flex-1 bg-transparent text-[13.5px] placeholder:text-subtle focus:outline-none pointer-coarse:h-10" />
    </form>
  )
}

export function MoreLink({ to, count }: { to: string; count: number }) {
  if (count <= 0) return null
  return <Link to={to} className="block px-2 pt-1 text-[12.5px] font-medium text-accent hover:underline">{t('+{count} more', { count })}</Link>
}
