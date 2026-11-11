/**
 * What someone sees when they open a share link (/s/<token>): a read-only copy of a
 * chat, a document or a project. No login, no sidebar, nothing to press that changes
 * anything. The page only asks the server for this one copy. In a shared project, a
 * document or a task with notes opens on the same page (`?doc=2` is the third document
 * of the copy, `?task=0` its first task); links between them use the same addresses.
 */
import { type ReactNode, useEffect, useRef } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import {
  ArrowLeft, CalendarDays, CheckCircle2, CheckSquare, ChevronRight, Circle, FileText, Link2Off, MessageSquare, Paperclip, Square,
} from 'lucide-react'
import { ApiError } from '@/api/client'
import { Logo } from '@/components/ui/Logo'
import { Markdown } from '@/components/ui/Markdown'
import { splitFrontMatter } from '@/features/documents/markdown'
import { cn } from '@/lib/cn'
import { formatUpcoming } from '@/lib/format'
import { dateLocale, msg, t } from '@/lib/i18n'
import { type Shared, useShared } from './api'

type SharedMessage = NonNullable<Shared['messages']>[number]
type SharedProject = NonNullable<Shared['project']>
type SharedEvent = NonNullable<SharedProject['events']>[number]
type SharedTask = NonNullable<SharedProject['tasks']>[number]

const KIND = { chat: msg('· shared chat, read-only'), document: msg('· shared document, read-only'), project: msg('· shared project, read-only') } as const
const STATUS: Record<string, string> = { todo: msg('To do'), in_progress: msg('In progress'), blocked: msg('Blocked'), done: msg('Done') }

/** A document's text for reading: without the `---` block at the top, and without a
 *  first heading that only repeats the title shown above it. */
function documentBody(markdown: string, title: string): string {
  const body = splitFrontMatter(markdown).body.trimStart()
  const [first, ...rest] = body.split('\n')
  return first.trim() === `# ${title}` ? rest.join('\n') : body
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', year: 'numeric' })

function Chip({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2.5 py-1 text-[12px] text-muted [&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:shrink-0">
      {icon} <span className="truncate">{children}</span>
    </span>
  )
}

function Message({ message }: { message: SharedMessage }) {
  const extras = (message.references?.length ?? 0) + (message.attachments?.length ?? 0) > 0 && (
    <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
      {message.references?.map((title) => <Chip key={`r-${title}`} icon={<MessageSquare />}>{title}</Chip>)}
      {message.attachments?.map((name) => <Chip key={`a-${name}`} icon={<Paperclip />}>{name}</Chip>)}
    </div>
  )
  if (message.role === 'user') {
    return (
      <div className="flex flex-col items-end gap-2">
        {extras}
        {message.text && (
          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-accent-soft px-4 py-2.5 text-[14.5px]">
            {message.text}
          </div>
        )}
      </div>
    )
  }
  return (
    <div>
      <Markdown text={message.text} />
      {message.model && <div className="mt-1.5 text-[12px] text-subtle">{message.model}</div>}
    </div>
  )
}

function Section({ title, empty, children }: { title: string; empty: string; children: ReactNode[] }) {
  return (
    <section>
      <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-muted">{title}</h2>
      {children.length === 0 ? (
        <p className="text-[13.5px] text-subtle">{empty}</p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-card border border-border bg-card">{children}</ul>
      )}
    </section>
  )
}

const ROW = 'flex items-center gap-3 px-3.5 py-2.5 text-[14px] [&>svg]:h-4 [&>svg]:w-4 [&>svg]:shrink-0 [&>svg]:text-muted'

/** One line of a list. With `to` it is a link that opens that entry on this page. */
function Row({ icon, children, aside, to, className }: { icon: ReactNode; children: ReactNode; aside?: ReactNode; to?: string; className?: string }) {
  const body = (
    <>
      {icon}
      <span className="min-w-0 flex-1 break-words">{children}</span>
      {aside && <span className="shrink-0 text-[12.5px] text-muted">{aside}</span>}
    </>
  )
  if (!to) return <li className={cn(ROW, className)}>{body}</li>
  return (
    <li>
      <Link to={to} className={cn(ROW, 'hover:bg-surface-hover pointer-coarse:py-3', className)}>
        {body}
        <ChevronRight className="text-subtle" />
      </Link>
    </li>
  )
}

const taskState = (task: SharedTask) => {
  const checklist = task.checklist ?? []
  return [
    t(STATUS[task.status] ?? task.status),
    task.due_date ? t('due {date}', { date: day(task.due_date) }) : '',
    checklist.length ? t('{done}/{total} checked', { done: checklist.filter((i) => i.done).length, total: checklist.length }) : '',
  ].filter(Boolean).join(' · ')
}

/** Whether a task has more than its title to show: notes, a checklist, subtasks or tasks it waits on. */
const hasDetails = (tasks: SharedTask[], index: number) => {
  const task = tasks[index]
  return Boolean(task.description?.trim() || task.checklist?.length || task.blocked_by?.length
    || tasks.some((t) => t.subtask_of === index))
}

/** A task in the list. One with more than a title opens on its own page, however long its notes are. */
function TaskItem({ tasks, index, nested = false }: { tasks: SharedTask[]; index: number; nested?: boolean }) {
  const task = tasks[index]
  const done = task.status === 'done'
  return (
    <Row icon={done ? <CheckCircle2 /> : <Circle />} aside={taskState(task)} to={hasDetails(tasks, index) ? `?task=${index}` : undefined}
      className={nested ? 'pl-9' : undefined}>
      <span className={done ? 'text-muted line-through' : undefined}>{task.title}</span>
    </Row>
  )
}

/** A task on its own page: its notes, checklist, subtasks and what it waits on. */
function TaskDetails({ tasks, index }: { tasks: SharedTask[]; index: number }) {
  const task = tasks[index]
  const subtasks = tasks.map((t, i) => [t, i] as const).filter(([t]) => t.subtask_of === index)
  const waitsOn = (task.blocked_by ?? []).filter((i) => tasks[i])
  return (
    <div className="flex flex-col gap-7">
      {task.description?.trim() && <Markdown text={task.description} />}
      {(task.checklist ?? []).length > 0 && (
        <ul aria-label={t('Checklist')} className="flex flex-col gap-1.5 text-[14px]">
          {(task.checklist ?? []).map((item, i) => (
            <li key={i} className="flex items-start gap-2.5">
              {item.done ? <CheckSquare className="mt-0.5 h-4 w-4 shrink-0 text-success" /> : <Square className="mt-0.5 h-4 w-4 shrink-0 text-muted" />}
              <span className={item.done ? 'text-muted line-through' : undefined}>{item.text}</span>
            </li>
          ))}
        </ul>
      )}
      {subtasks.length > 0 && (
        <Section title={t('Subtasks')} empty="">
          {subtasks.map(([, i]) => <TaskItem key={i} tasks={tasks} index={i} />)}
        </Section>
      )}
      {waitsOn.length > 0 && (
        <Section title={t('Waits on')} empty="">
          {waitsOn.map((i) => <TaskItem key={i} tasks={tasks} index={i} />)}
        </Section>
      )}
    </div>
  )
}

function eventWhen(e: SharedEvent): string {
  if (!e.all_day || !e.start_date) return formatUpcoming(e.start_at)
  return e.end_date && e.end_date !== e.start_date ? `${day(e.start_date)} – ${day(e.end_date)}` : day(e.start_date)
}

function ProjectOverview({ project }: { project: SharedProject }) {
  return (
    <div className="flex flex-col gap-7">
      {project.tasks && (
        <Section title={t('Tasks')} empty={t('No tasks.')}>
          {/* Subtasks right under their task (those whose task is not in the copy, on their own). */}
          {project.tasks.flatMap((t, i) => t.subtask_of != null ? [] : [
            <TaskItem key={i} tasks={project.tasks!} index={i} />,
            ...project.tasks!.flatMap((sub, j) => sub.subtask_of === i ? [<TaskItem key={j} tasks={project.tasks!} index={j} nested />] : []),
          ])}
        </Section>
      )}
      {project.events && (
        <Section title={t('Upcoming events')} empty={t('Nothing in the next 90 days.')}>
          {project.events.map((e, i) => <Row key={i} icon={<CalendarDays />} aside={eventWhen(e)}>{e.title}</Row>)}
        </Section>
      )}
      {project.documents && (
        <Section title={t('Documents')} empty={t('No documents.')}>
          {project.documents.map((d, i) => <Row key={i} icon={<FileText />} to={`?doc=${i}`}>{d.title}</Row>)}
        </Section>
      )}
    </div>
  )
}

function Unavailable({ tooMany }: { tooMany: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-2 text-muted">
        <Link2Off className="h-5 w-5" />
      </div>
      <h1 className="text-lg font-semibold">{tooMany ? t('Too many attempts') : t('This link is no longer available')}</h1>
      <p className="max-w-sm text-[13.5px] text-muted">
        {tooMany
          ? t('Please wait a minute and open the link again.')
          : t('It may have expired or been withdrawn by the person who shared it. Ask them for a new one.')}
      </p>
    </div>
  )
}

export function SharedPage() {
  const { token = '' } = useParams()
  const shared = useShared(token)
  const data = shared.data
  // A document or a task of a shared project, when one is open.
  const [params] = useSearchParams()
  const at = (key: string) => (params.has(key) ? Number(params.get(key)) : -1)
  const document_ = data?.project?.documents?.[at('doc')]
  const task = document_ ? undefined : data?.project?.tasks?.[at('task')]
  const opened = document_ ?? task
  const title = opened?.title ?? data?.title
  useEffect(() => {
    if (title) document.title = `${title} · Anemo`
  }, [title])
  // Each entry starts at its top, also when reached through a link far down another one.
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    scroller.current?.scrollTo(0, 0)
  }, [params])

  if (shared.isError) {
    return <Unavailable tooMany={shared.error instanceof ApiError && shared.error.status === 429} />
  }
  if (!data) return null

  return (
    <div ref={scroller} className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 pb-16 pt-6 md:px-8 md:pt-10">
        <header className="mb-7 border-b border-border pb-5">
          <div className="mb-3 flex items-center gap-2 text-[13px] text-muted">
            <Logo className="h-6 w-6 text-accent" />
            <span className="font-semibold text-text">Anemo</span>
            <span>{t(KIND[data.kind])}</span>
          </div>
          {opened && (
            <Link to="." className="-ml-1 mb-1 inline-flex h-8 items-center gap-1 pr-2 text-[13px] text-muted hover:text-text pointer-coarse:h-10">
              <ArrowLeft className="h-4 w-4" /> {data.title}
            </Link>
          )}
          <h1 className="break-words text-2xl font-semibold">{title}</h1>
          <p className="mt-1 text-[13px] text-muted">
            {data.kind === 'chat' && data.started_at && <>{t('Started {date}', { date: day(data.started_at) })} · </>}
            {task && <>{taskState(task)} · </>}
            {t('A copy from {date}. It does not change when the original does.', { date: day(data.shared_at) })}
          </p>
        </header>

        {data.kind === 'chat' && (
          <div className="flex flex-col gap-6">
            {(data.messages ?? []).map((m, i) => <Message key={i} message={m} />)}
            {(data.messages ?? []).length === 0 && <p className="text-[13.5px] text-subtle">{t('This chat has no messages.')}</p>}
          </div>
        )}
        {data.kind === 'document' && <Markdown text={documentBody(data.markdown ?? '', data.title)} />}
        {data.kind === 'project' && data.project && (
          document_ ? <Markdown text={documentBody(document_.markdown, document_.title)} />
            : task ? <TaskDetails tasks={data.project.tasks ?? []} index={at('task')} />
            : <ProjectOverview project={data.project} />
        )}
      </div>
    </div>
  )
}
