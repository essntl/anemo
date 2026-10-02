/**
 * What someone sees when they open a share link (/s/<token>): a read-only copy of a
 * chat, a document or a project. No login, no sidebar, nothing to press that changes
 * anything. The page only asks the server for this one copy. In a shared project, a
 * document opens on the same page (`?doc=2` is the third document of the copy).
 */
import { type ReactNode, useEffect } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { ArrowLeft, CalendarDays, CheckCircle2, ChevronRight, Circle, FileText, Link2Off, MessageSquare, Paperclip } from 'lucide-react'
import { ApiError } from '@/api/client'
import { Logo } from '@/components/ui/Logo'
import { Markdown } from '@/components/ui/Markdown'
import { splitFrontMatter } from '@/features/documents/markdown'
import { formatUpcoming } from '@/lib/format'
import { type Shared, useShared } from './api'

type SharedMessage = NonNullable<Shared['messages']>[number]
type SharedProject = NonNullable<Shared['project']>
type SharedEvent = NonNullable<SharedProject['events']>[number]

const KIND = { chat: 'Chat', document: 'Document', project: 'Project' } as const
const STATUS: Record<string, string> = { todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done' }

/** A document's text for reading: without the `---` block at the top, and without a
 *  first heading that only repeats the title shown above it. */
function documentBody(markdown: string, title: string): string {
  const body = splitFrontMatter(markdown).body.trimStart()
  const [first, ...rest] = body.split('\n')
  return first.trim() === `# ${title}` ? rest.join('\n') : body
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

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
        <ul className="divide-y divide-border rounded-card border border-border bg-card">{children}</ul>
      )}
    </section>
  )
}

function Row({ icon, children, aside }: { icon: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <li className="flex items-center gap-3 px-3.5 py-2.5 text-[14px] [&>svg]:h-4 [&>svg]:w-4 [&>svg]:shrink-0 [&>svg]:text-muted">
      {icon}
      <span className="min-w-0 flex-1 break-words">{children}</span>
      {aside && <span className="shrink-0 text-[12.5px] text-muted">{aside}</span>}
    </li>
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
        <Section title="Tasks" empty="No tasks.">
          {project.tasks.map((t, i) => (
            <Row key={i} icon={t.status === 'done' ? <CheckCircle2 /> : <Circle />}
              aside={[STATUS[t.status] ?? t.status, t.due_date ? `due ${day(t.due_date)}` : ''].filter(Boolean).join(' · ')}>
              <span className={t.status === 'done' ? 'text-muted line-through' : undefined}>{t.title}</span>
            </Row>
          ))}
        </Section>
      )}
      {project.events && (
        <Section title="Upcoming events" empty="Nothing in the next 90 days.">
          {project.events.map((e, i) => <Row key={i} icon={<CalendarDays />} aside={eventWhen(e)}>{e.title}</Row>)}
        </Section>
      )}
      {project.documents && (
        <Section title="Documents" empty="No documents.">
          {project.documents.map((d, i) => (
            <li key={i}>
              <Link to={`?doc=${i}`} className="flex items-center gap-3 px-3.5 py-2.5 text-[14px] hover:bg-surface-hover pointer-coarse:py-3">
                <FileText className="h-4 w-4 shrink-0 text-muted" />
                <span className="min-w-0 flex-1 break-words">{d.title}</span>
                <ChevronRight className="h-4 w-4 shrink-0 text-subtle" />
              </Link>
            </li>
          ))}
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
      <h1 className="text-lg font-semibold">{tooMany ? 'Too many attempts' : 'This link is no longer available'}</h1>
      <p className="max-w-sm text-[13.5px] text-muted">
        {tooMany
          ? 'Please wait a minute and open the link again.'
          : 'It may have expired or been withdrawn by the person who shared it. Ask them for a new one.'}
      </p>
    </div>
  )
}

export function SharedPage() {
  const { token = '' } = useParams()
  const shared = useShared(token)
  const data = shared.data
  // A document of a shared project, when one is open.
  const [params] = useSearchParams()
  const opened = params.has('doc') ? data?.project?.documents?.[Number(params.get('doc'))] : undefined
  const title = opened?.title ?? data?.title
  useEffect(() => {
    if (title) document.title = `${title} · Anemo`
  }, [title])

  if (shared.isError) {
    return <Unavailable tooMany={shared.error instanceof ApiError && shared.error.status === 429} />
  }
  if (!data) return null

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 pb-16 pt-6 md:px-8 md:pt-10">
        <header className="mb-7 border-b border-border pb-5">
          <div className="mb-3 flex items-center gap-2 text-[13px] text-muted">
            <Logo className="h-6 w-6 text-accent" />
            <span className="font-semibold text-text">Anemo</span>
            <span>· shared {KIND[data.kind].toLowerCase()}, read-only</span>
          </div>
          {opened && (
            <Link to="." className="-ml-1 mb-1 inline-flex h-8 items-center gap-1 pr-2 text-[13px] text-muted hover:text-text pointer-coarse:h-10">
              <ArrowLeft className="h-4 w-4" /> {data.title}
            </Link>
          )}
          <h1 className="break-words text-2xl font-semibold">{title}</h1>
          <p className="mt-1 text-[13px] text-muted">
            {data.kind === 'chat' && data.started_at && <>Started {day(data.started_at)} · </>}
            A copy from {day(data.shared_at)}. It does not change when the original does.
          </p>
        </header>

        {data.kind === 'chat' && (
          <div className="flex flex-col gap-6">
            {(data.messages ?? []).map((m, i) => <Message key={i} message={m} />)}
            {(data.messages ?? []).length === 0 && <p className="text-[13.5px] text-subtle">This chat has no messages.</p>}
          </div>
        )}
        {data.kind === 'document' && <Markdown text={documentBody(data.markdown ?? '', data.title)} />}
        {data.kind === 'project' && data.project && (
          opened ? <Markdown text={documentBody(opened.markdown, opened.title)} /> : <ProjectOverview project={data.project} />
        )}
      </div>
    </div>
  )
}
