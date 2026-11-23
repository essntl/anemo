/**
 * A thread of Claude Code jobs (a job and its follow-ups, docs/specs/code-sessions.md
 * §7.3): the header, the todo list (pinned while the job runs), and each job's prompt,
 * timeline and result, with a separator per follow-up. A running job follows its live
 * stream; the view sticks to the bottom until the user scrolls up.
 */
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router'
import {
  ArrowLeft, CheckCircle2, ChevronRight, Copy, GitBranch, GitPullRequest, Loader2, Monitor, Ban, TriangleAlert, XCircle, Folder,
} from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Elapsed } from '@/components/ui/Elapsed'
import { Markdown } from '@/components/ui/Markdown'
import { toast } from '@/components/ui/toast'
import { useStickToBottom } from '@/features/chat/useStickToBottom'
import { cn } from '@/lib/cn'
import { formatCost, formatDuration, formatWhen } from '@/lib/format'
import { t } from '@/lib/i18n'
import { useCodeEvents, useCodeJob } from './api'
import { CodeTimeline } from './CodeTimeline'
import { JobContext } from './jobContext'
import { StateBadge, TodoChecklist } from './parts'
import { type CodeJob, jobDurationMs, pullRequest, toThreads } from './threads'
import { type ResultInfo, buildTimeline, num, resultOf, todoProgress, toTodos } from './timeline'

function Fact({ icon, children, className }: { icon: ReactNode; children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex min-w-0 max-w-full items-center gap-1.5', className)}>
      <span className="shrink-0 text-subtle [&_svg]:h-3.5 [&_svg]:w-3.5" aria-hidden="true">{icon}</span>
      {children}
    </span>
  )
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-subtle">{label}</div>
      <div className="mt-0.5 text-[13px] tabular-nums">{children}</div>
    </div>
  )
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast({ message: t('Copied') })
  } catch {
    toast({ message: t('Could not copy') })
  }
}

/** The job's end: its summary, turns, time and API-equivalent cost. */
function ResultCard({ job, result }: { job: CodeJob; result?: ResultInfo }) {
  const state = job.state
  if (state === 'running') return null
  const text = job.result_text ?? result?.text
  const turns = num(job.num_turns) ?? result?.numTurns
  const ms = jobDurationMs(job) ?? result?.durationMs ?? null
  const cost = num(job.cost_usd) ?? result?.costUsd
  const subtype = job.result_subtype ?? result?.subtype
  const failed = state === 'failed' || state === 'exited_without_result'
  const head = {
    done: { icon: <CheckCircle2 className="h-4 w-4 text-tool-ok" />, label: t('Finished') },
    failed: { icon: <XCircle className="h-4 w-4 text-error" />, label: subtype && subtype !== 'success' ? t('Failed: {reason}', { reason: subtype }) : t('Failed') },
    cancelled: { icon: <Ban className="h-4 w-4 text-muted" />, label: t('Cancelled') },
    exited_without_result: { icon: <TriangleAlert className="h-4 w-4 text-warning" />, label: t('Exited without a result') },
  }[state]
  return (
    <section aria-label={t('Result')} className={cn('mx-2 mt-3 rounded-xl border bg-surface p-3', failed ? 'border-error/40' : 'border-border')}>
      <div className="flex items-center gap-2 text-[13px] font-semibold">{head.icon}{head.label}</div>
      {text && <div className="mt-2 min-w-0 text-[14px]"><Markdown text={text} /></div>}
      {state === 'exited_without_result' && job.stderr_tail && (
        <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2 p-2.5 font-mono text-[11.5px] text-error">{job.stderr_tail}</pre>
      )}
      {state === 'exited_without_result' && !job.stderr_tail && (
        <p className="mt-2 text-[12.5px] text-muted">{t('The process ended without writing a result.')}</p>
      )}
      {(turns !== undefined || ms !== null || cost !== undefined) && (
        <div className="mt-3 grid grid-cols-2 gap-3 border-t border-border pt-3 sm:grid-cols-3">
          {turns !== undefined && <Stat label={t('Turns')}>{turns}</Stat>}
          {ms !== null && <Stat label={t('Duration')}>{formatDuration(ms / 1000)}</Stat>}
          {cost !== undefined && <Stat label={t('API-equivalent cost')}>{formatCost(cost)}</Stat>}
        </div>
      )}
    </section>
  )
}

/** The prompt that started a job, as the user's message. Long ones fold. */
function Prompt({ text }: { text: string }) {
  const [all, setAll] = useState(false)
  const long = text.length > 800 || text.split('\n').length > 14
  return (
    <div className="ml-auto max-w-[min(42rem,92%)] rounded-2xl rounded-br-md bg-accent-soft px-3.5 py-2.5 text-[13.5px]">
      <p className={cn('whitespace-pre-wrap break-words', long && !all && 'line-clamp-[12]')}>{text}</p>
      {long && (
        <button type="button" onClick={() => setAll(!all)} className="mt-1 text-[12px] font-medium text-accent hover:underline">
          {all ? t('Show less') : t('Show all')}
        </button>
      )}
    </div>
  )
}

/** One job of the thread: its prompt, its timeline (live while it runs) and its result. */
function JobPart({ job, index, onSize }: { job: CodeJob; index: number; onSize?: (count: number) => void }) {
  const running = job.state === 'running'
  const events = useCodeEvents(job.id, { live: running, lastSeq: job.last_seq })
  const items = useMemo(() => buildTimeline(events.data ?? []), [events.data])
  const count = events.data?.length ?? 0
  useEffect(() => onSize?.(count), [count, onSize])
  const view = useMemo(() => ({ job, running }), [job, running])
  return (
    <JobContext.Provider value={view}>
      <div data-testid="code-job" className="flex flex-col gap-2">
        {index > 0 && (
          <div className="my-3 flex items-center gap-3 text-[11.5px] font-medium text-subtle" role="separator">
            <span className="h-px flex-1 bg-border" />
            {t('Follow-up · started {when}', { when: formatWhen(job.started_at) })}
            <span className="h-px flex-1 bg-border" />
          </div>
        )}
        <Prompt text={job.prompt} />
        <div className="min-w-0">
          {events.isPending && <p className="px-2 py-1 text-[12.5px] text-muted">{t('Loading…')}</p>}
          {events.isError && (
            <p className="px-2 py-1 text-[12.5px] text-error">
              {errorMessage(events.error)}{' '}
              <button type="button" className="font-medium text-accent hover:underline" onClick={() => void events.refetch()}>{t('Retry')}</button>
            </p>
          )}
          <CodeTimeline items={items} />
          {running && events.isSuccess && (
            <p className="flex items-center gap-2 px-2 py-1.5 text-[12.5px] text-muted">
              <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin text-tool-running" />
              <span className="shimmer">{items.length ? t('Working…') : t('Waiting for the first events…')}</span>
            </p>
          )}
          <ResultCard job={job} result={resultOf(items)} />
        </div>
      </div>
    </JobContext.Provider>
  )
}

function Todos({ job }: { job: CodeJob }) {
  const todos = useMemo(() => toTodos(job.todos), [job.todos])
  const running = job.state === 'running'
  const [open, setOpen] = useState(false)
  if (!todos.length) return null
  const shown = running || open
  return (
    <div className={cn('z-10 mb-3 rounded-xl border border-border bg-surface/95 px-3 py-2 shadow-soft backdrop-blur', running && 'sticky top-0')}>
      <button type="button" onClick={() => setOpen(!open)} disabled={running} aria-expanded={shown}
        className="flex w-full items-center gap-2 text-left text-[12px] font-semibold uppercase tracking-wider text-subtle">
        {t('Todo list')}
        <span className="font-mono normal-case tracking-normal text-muted" aria-label={t('{done} of {total} done', { done: todos.filter((x) => x.status === 'completed').length, total: todos.length })}>
          {todoProgress(todos)}
        </span>
        {!running && <ChevronRight aria-hidden="true" className={cn('ml-auto h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />}
      </button>
      {shown && <div className="mt-1.5 max-h-[40vh] overflow-y-auto"><TodoChecklist todos={todos} running={running} /></div>}
    </div>
  )
}

function Header({ thread }: { thread: CodeJob[] }) {
  const first = thread[0]
  const latest = thread[thread.length - 1]
  const summary = toThreads(thread)[0]
  const running = latest.state === 'running'
  const device = latest.device
  const pr = pullRequest(thread.map((j) => j.pr_url).filter(Boolean).at(-1))
  const branch = latest.branch ?? thread.map((j) => j.branch).filter(Boolean).at(-1)
  const session = latest.session_id
  return (
    <header className="mb-4 px-2">
      <div className="flex flex-wrap items-center gap-2">
        <StateBadge state={latest.state} />
        {running && <Elapsed since={latest.started_at} className="text-[12.5px] text-muted" />}
        <span className="text-[12px] text-muted">{formatWhen(first.started_at)}</span>
      </div>
      <h2 className="mt-2 break-words text-lg font-semibold">{first.title || t('(no title)')}</h2>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-[12.5px] text-muted">
        <Fact icon={<Folder />}>
          <span className="font-medium text-text">{latest.project}</span>
          <span className="min-w-0 break-all font-mono text-[11.5px]">{latest.dir}</span>
        </Fact>
        <Fact icon={<Monitor />}>
          <span>{device.name}</span>
          {!device.online && (
            <span data-testid="device-offline" className="rounded-full bg-warning/12 px-1.5 text-[11px] font-medium text-warning">
              {device.last_seen_at ? t('offline since {when}', { when: formatWhen(device.last_seen_at) }) : t('offline')}
            </span>
          )}
        </Fact>
        {branch && (
          <Fact icon={<GitBranch />}>
            {pr ? (
              <a href={`https://github.com/${pr.repo}/tree/${encodeURIComponent(branch).replace(/%2F/g, '/')}`} target="_blank" rel="noreferrer noopener"
                className="min-w-0 break-all font-mono text-[11.5px] text-accent hover:underline">{branch}</a>
            ) : <span className="min-w-0 break-all font-mono text-[11.5px]">{branch}</span>}
          </Fact>
        )}
        {pr && (
          <Fact icon={<GitPullRequest />}>
            <a href={pr.url} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">
              {t('Pull request #{number}', { number: pr.number })}
            </a>
          </Fact>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-x-6 gap-y-2">
        {latest.model && <Stat label={t('Model')}>{latest.model}</Stat>}
        {summary.turns !== null && <Stat label={t('Turns')}>{summary.turns}</Stat>}
        {summary.costUsd !== null && <Stat label={t('API-equivalent cost')}>{formatCost(summary.costUsd)}</Stat>}
        {session && (
          <Stat label={t('Session')}>
            <span className="inline-flex max-w-full items-center gap-1">
              <span className="min-w-0 truncate font-mono text-[11.5px]">{session}</span>
              <button type="button" onClick={() => void copy(session)} aria-label={t('Copy session id')} title={t('Copy session id')}
                className="shrink-0 rounded p-1 text-muted hover:bg-surface-hover hover:text-text">
                <Copy className="h-3.5 w-3.5" />
              </button>
            </span>
          </Stat>
        )}
      </div>
    </header>
  )
}

/** The thread of the job `jobId`. `backTo` is the list's address (phones show a back link). */
export function CodeThreadView({ jobId, backTo }: { jobId: string; backTo: string }) {
  const detail = useCodeJob(jobId)
  const data = detail.data
  const thread = useMemo(() => {
    if (!data) return []
    const jobs = data.thread.length ? data.thread : [data.job]
    return toThreads(jobs)[0]?.jobs ?? jobs
  }, [data])
  const latest = thread.at(-1)
  // How many events the latest job has loaded: the view follows them while it runs
  // (scrolling up stops that), and once more when it ends (its result).
  const [size, setSize] = useState(0)
  const scroller = useStickToBottom(latest?.state === 'running' ? `${latest.id}:${size}` : latest?.id)
  const location = useLocation()

  return (
    <div ref={scroller} className="h-full overflow-y-auto overscroll-contain">
      <div className="mx-auto max-w-3xl px-2 pb-10 pt-2 md:px-6">
        <Link to={backTo} state={location.state} className="mb-3 ml-2 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-text lg:hidden">
          <ArrowLeft className="h-4 w-4" /> {t('All jobs')}
        </Link>
        {detail.isPending && <p className="p-2 text-[13px] text-muted">{t('Loading…')}</p>}
        {detail.isError && (
          <div className="p-2 text-[13px]">
            <p className="text-error">{errorMessage(detail.error)}</p>
            <Button size="sm" className="mt-2" onClick={() => void detail.refetch()}>{t('Try again')}</Button>
          </div>
        )}
        {latest && (
          <>
            <Header thread={thread} />
            <Todos job={latest} />
            <div className="flex flex-col">
              {thread.map((job, i) => <JobPart key={job.id} job={job} index={i} onSize={i === thread.length - 1 ? setSize : undefined} />)}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
