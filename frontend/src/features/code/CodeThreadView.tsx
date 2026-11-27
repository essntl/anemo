/**
 * A thread of Claude Code jobs (a job and its follow-ups, docs/specs/code-sessions.md
 * §7.3): the header, the todo list (pinned while the job runs), and each job's prompt,
 * timeline and result, with a separator per follow-up. A running job follows its live
 * stream; the view sticks to the bottom until the user scrolls up.
 *
 * When the jobs started sub-agents (agents.ts), their work isn't mixed into the main
 * timeline: a list beside the thread (a switcher in the top bar on narrower screens)
 * picks the agent whose events are shown, kept in the address as `?agent=<call id>`.
 */
import { DelayedLoading } from '@/components/ui/DelayedLoading'
import { type ReactNode, useCallback, useMemo, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import {
  ArrowDown, ArrowLeft, CheckCircle2, ChevronRight, Copy, GitBranch, GitPullRequest, Loader2, Monitor, Ban, TriangleAlert, XCircle, Folder,
} from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Elapsed } from '@/components/ui/Elapsed'
import { Markdown } from '@/components/ui/Markdown'
import { toast } from '@/components/ui/toast'
import { useIslandVisible } from '@/features/island/islandStore'
import { DESKTOP, useMediaQuery } from '@/hooks/useMediaQuery'
import { cn } from '@/lib/cn'
import { formatCost, formatCount, formatDuration, formatWhen } from '@/lib/format'
import { t } from '@/lib/i18n'
import { AGENT_PARAM, type AgentInfo, MAIN, agentTree, agentsOf, eventsOfAgent } from './agents'
import { type AgentNav, AgentNavContext, type ThreadAgent } from './agentNav'
import { AgentFacts, AgentSidebar, AgentStatusIcon, AgentSwitcher } from './AgentSidebar'
import { useCodeEvents, useCodeJob, useThreadEvents } from './api'
import { CodeTimeline } from './CodeTimeline'
import { CancelJobButton, FollowUpBox, FromChat } from './controls'
import { JobContext } from './jobContext'
import { StateBadge, TodoChecklist } from './parts'
import { type CodeJob, jobDurationMs, pullRequest, toThreads } from './threads'
import { PromptImages } from './ImageAttachments'
import { useFollowEnd } from './useFollowEnd'
import { JobUsage } from './UsageMeter'
import { LimitPanel } from './LimitPanel'
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
  const tokens = job.tokens
  const failed = state === 'failed' || state === 'exited_without_result'
  const head = {
    done: { icon: <CheckCircle2 className="h-4 w-4 text-tool-ok" />, label: t('Finished') },
    failed: {
      icon: <XCircle className="h-4 w-4 text-error" />,
      label: job.limit_hit ? t('Stopped at the usage limit') : subtype && subtype !== 'success' ? t('Failed: {reason}', { reason: subtype }) : t('Failed'),
    },
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
      {(turns !== undefined || ms !== null || cost !== undefined || tokens) && (
        <div className="mt-3 grid grid-cols-2 gap-3 border-t border-border pt-3 sm:grid-cols-4">
          {turns !== undefined && <Stat label={t('Turns')}>{turns}</Stat>}
          {ms !== null && <Stat label={t('Duration')}>{formatDuration(ms / 1000)}</Stat>}
          {tokens && (
            <Stat label={t('Tokens')}>
              <span title={t('{input} input ({cached} read from the cache, {written} written to it) · {output} output', {
                input: formatCount(tokens.input + tokens.cache_read + tokens.cache_creation),
                cached: formatCount(tokens.cache_read), written: formatCount(tokens.cache_creation), output: formatCount(tokens.output),
              })}>
                {t('{input} in · {output} out', { input: formatCount(tokens.input + tokens.cache_read + tokens.cache_creation), output: formatCount(tokens.output) })}
              </span>
            </Stat>
          )}
          {cost !== undefined && <Stat label={t('API-equivalent cost')}>{formatCost(cost)}</Stat>}
        </div>
      )}
    </section>
  )
}

/** The prompt that started a job, as the user's message, with the images sent with it. Long ones fold. */
function Prompt({ text, images = [] }: { text: string; images?: readonly { id: string; name: string }[] }) {
  const [all, setAll] = useState(false)
  const long = text.length > 800 || text.split('\n').length > 14
  return (
    // As in a chat, no avatar beside your own message: its place on the right says who wrote it.
    <div className="flex justify-end">
      <div className="max-w-[min(42rem,92%)] rounded-2xl rounded-br-md bg-accent-soft px-3.5 py-2.5 text-[13.5px]">
        <p className={cn('whitespace-pre-wrap break-words', long && !all && 'line-clamp-[12]')}>{text}</p>
        {long && (
          <button type="button" onClick={() => setAll(!all)} className="mt-1 text-[12px] font-medium text-accent hover:underline">
            {all ? t('Show less') : t('Show all')}
          </button>
        )}
        <PromptImages images={images} className="mt-2" />
      </div>
    </div>
  )
}

/** A sub-agent's view starts with what it was asked, and the way back to the main agent. */
function AgentHead({ agent, onMain }: { agent: AgentInfo; onMain: () => void }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 text-[12.5px] text-muted">
        <button type="button" onClick={onMain} className="inline-flex items-center gap-1 rounded px-1 font-medium text-accent hover:underline">
          <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />{t('Main agent')}
        </button>
        <span aria-hidden="true">/</span>
        <AgentStatusIcon status={agent.status} />
        <span className="min-w-0 break-words font-medium text-text">{agent.description}</span>
        {agent.type && <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px]">{agent.type}</span>}
        <span className="text-subtle"><AgentFacts agent={agent} /></span>
      </div>
      {agent.prompt && <Prompt text={agent.prompt} />}
    </div>
  )
}

/**
 * One job of the thread: its prompt, its timeline (live while it runs) and its result.
 * `agent`: the agent shown (MAIN, or a sub-agent's call id); `agents`: this job's
 * sub-agents. A part whose job didn't start the sub-agent shown draws nothing (it still
 * keeps its events live).
 */
function JobPart({ job, index, last, agent, agents, onMain }: { job: CodeJob; index: number; last: boolean; agent: string; agents: AgentInfo[]; onMain: () => void }) {
  const running = job.state === 'running'
  const events = useCodeEvents(job.id, { live: running, lastSeq: job.last_seq })
  const own = agent === MAIN ? undefined : agents.find((a) => a.id === agent)
  const shown = useMemo(() => {
    const all = events.data ?? []
    return agents.length ? eventsOfAgent(all, agents, own?.id ?? MAIN) : all
  }, [events.data, agents, own?.id])
  const items = useMemo(() => buildTimeline(shown), [shown])
  const view = useMemo(() => ({ job, running }), [job, running])
  if (agent !== MAIN && !own) return null
  if (own) {
    return (
      <JobContext.Provider value={view}>
        <div data-testid="code-agent" className="flex flex-col gap-2">
          <AgentHead agent={own} onMain={onMain} />
          <div className="min-w-0">
            <CodeTimeline items={items} />
            {own.status === 'running' && (
              <p className="flex items-center gap-2 px-2 py-1.5 text-[12.5px] text-muted">
                <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin text-tool-running" />
                <span className="shimmer">{items.length ? t('Working…') : t('Waiting for the first events…')}</span>
              </p>
            )}
            {own.resultText && (
              <section aria-label={t('Result')} className={cn('mx-2 mt-3 rounded-xl border bg-surface p-3', own.status === 'failed' ? 'border-error/40' : 'border-border')}>
                <div className="min-w-0 text-[14px]"><Markdown text={own.resultText} /></div>
              </section>
            )}
          </div>
        </div>
      </JobContext.Provider>
    )
  }
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
        <FromChat job={job} />
        <Prompt text={job.prompt} images={job.images ?? []} />
        <div className="min-w-0">
          {events.isPending && <DelayedLoading className="px-2 py-1 text-[12.5px]" />}
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
          <LimitPanel job={job} last={last} />
        </div>
      </div>
    </JobContext.Provider>
  )
}

/** From the `md` width up (and where it can't be asked). */
const roomy = () => typeof window.matchMedia !== 'function' || window.matchMedia(DESKTOP).matches

function Todos({ job }: { job: CodeJob }) {
  const todos = useMemo(() => toTodos(job.todos), [job.todos])
  const running = job.state === 'running'
  // Open while the job runs (folded on a phone, where the thread has little room) and
  // folded after, until the user says otherwise.
  const [chosen, setChosen] = useState<boolean | null>(null)
  if (!todos.length) return null
  const open = chosen ?? (running && roomy())
  const now = todos.find((x) => x.status === 'in_progress')
  return (
    <div className={cn('z-10 mb-3 rounded-xl border border-border bg-surface px-3 py-2 shadow-soft', running && 'sticky top-0')}>
      <button type="button" onClick={() => setChosen(!open)} aria-expanded={open}
        className="-my-1 flex w-full min-w-0 items-center gap-2 py-1 text-left text-[12px] font-semibold uppercase tracking-wider text-subtle pointer-coarse:-my-2 pointer-coarse:py-3">
        <span className="shrink-0">{t('Todo list')}</span>
        <span className="shrink-0 font-mono normal-case tracking-normal text-muted" aria-label={t('{done} of {total} done', { done: todos.filter((x) => x.status === 'completed').length, total: todos.length })}>
          {todoProgress(todos)}
        </span>
        {/* Folded: what is being done now is still in sight. */}
        {!open && running && now && <span className="min-w-0 truncate font-normal normal-case tracking-normal text-muted">{now.activeForm ?? now.content}</span>}
        <ChevronRight aria-hidden="true" className={cn('ml-auto h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
      </button>
      {open && <div className="mt-1.5 max-h-[40vh] overflow-y-auto"><TodoChecklist todos={todos} running={running} /></div>}
    </div>
  )
}

function Header({ thread }: { thread: CodeJob[] }) {
  const first = thread[0]
  const latest = thread[thread.length - 1]
  const summary = toThreads(thread)[0]
  const device = latest.device
  const pr = pullRequest(thread.map((j) => j.pr_url).filter(Boolean).at(-1))
  const branch = latest.branch ?? thread.map((j) => j.branch).filter(Boolean).at(-1)
  const session = latest.session_id
  return (
    <header className="mb-4 px-2">
      <h2 className="break-words text-lg font-semibold [overflow-wrap:anywhere]">{first.title || t('(no title)')}</h2>
      <p className="mt-0.5 text-[12px] text-muted">{t('started {when}', { when: formatWhen(first.started_at) })}</p>
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
      <JobUsage deviceId={device.id} />
    </header>
  )
}

/**
 * The bar over the thread, always in sight: the way back to the list (where the list is
 * a screen of its own), the state, the title and Cancel. On a phone it is the page's only
 * header (the app's top bar with the "Code" title is hidden there, see `ownPhoneHeader`
 * in app/router.tsx): one row as tall as a chat's header.
 */
function TopBar({ thread, backTo, switcher }: { thread: CodeJob[]; backTo: string; switcher?: ReactNode }) {
  const location = useLocation()
  const latest = thread.at(-1)
  // A phone while the Dynamic Island shows: it floats over the middle of this bar, so the
  // state and the title move to a slim row underneath, as in a chat.
  const island = useIslandVisible((s) => s.visible)
  const stacked = !useMediaQuery(DESKTOP) && island
  const about = latest && (
    <>
      <StateBadge state={latest.state} />
      {latest.state === 'running' && <Elapsed since={latest.started_at} className="shrink-0 text-[12.5px] text-muted max-sm:hidden" />}
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{thread[0].title || t('(no title)')}</span>
      {switcher}
      <CancelJobButton job={latest} />
    </>
  )
  return (
    <div className="shrink-0 border-b border-border">
      <div className="flex min-h-11 items-center gap-2 px-2.5 py-1 md:px-4 md:py-1.5">
        <Link to={backTo} state={location.state} aria-label={t('All jobs')} title={t('All jobs')}
          className="-ml-1 inline-flex h-8 min-w-8 shrink-0 items-center justify-center gap-1 rounded-control px-1.5 text-[13px] pointer-coarse:h-10 pointer-coarse:min-w-10 text-muted hover:bg-surface-hover hover:text-text lg:hidden">
          <ArrowLeft aria-hidden="true" className="h-4 w-4" /><span className="max-sm:hidden">{t('All jobs')}</span>
        </Link>
        {!stacked && about}
      </div>
      {stacked && about && <div className="-mt-1 flex h-10 items-center gap-2 px-3">{about}</div>}
    </div>
  )
}

/** Wide enough for the list of agents as a column of its own (`xl`); narrower, it is a switcher in the top bar. */
const WIDE = '(min-width: 1280px)'

/** The sub-agents of every job of the thread: per job, and all of them in the order they are listed. */
function useThreadAgents(thread: CodeJob[]) {
  const ids = useMemo(() => thread.map((j) => j.id), [thread])
  const events = useThreadEvents(ids)
  return useMemo(() => {
    const perJob = new Map<string, AgentInfo[]>()
    const all: ThreadAgent[] = []
    for (const job of thread) {
      const agents = agentsOf(events[job.id] ?? [], job.state === 'running')
      perJob.set(job.id, agents)
      all.push(...agentTree(agents).map((a) => ({ ...a, jobId: job.id })))
    }
    return { perJob, all }
  }, [thread, events])
}

const NO_AGENTS: AgentInfo[] = []

/** The thread of the job `jobId`. `backTo` is the list's address (narrow screens show a back link). */
export function CodeThreadView({ jobId, backTo }: { jobId: string; backTo: string }) {
  const detail = useCodeJob(jobId)
  const data = detail.data
  const thread = useMemo(() => {
    if (!data) return []
    const jobs = data.thread.length ? data.thread : [data.job]
    return toThreads(jobs)[0]?.jobs ?? jobs
  }, [data])
  const latest = thread.at(-1)
  // A thread opens on its latest result, a running one on what it does now, and both
  // follow what comes until the user scrolls up.
  const { scroller, content, away, toEnd } = useFollowEnd()

  // The agent shown: from the address; one this thread doesn't have (yet) shows the main one.
  const { perJob, all: agents } = useThreadAgents(thread)
  const [params, setParams] = useSearchParams()
  const wanted = params.get(AGENT_PARAM)
  const selected = wanted && agents.some((a) => a.id === wanted) ? wanted : MAIN
  const select = useCallback((agent: string) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (agent === MAIN) next.delete(AGENT_PARAM)
      else next.set(AGENT_PARAM, agent)
      return next
    })
  }, [setParams])
  const nav = useMemo<AgentNav | null>(
    () => (agents.length ? { byId: new Map(agents.map((a) => [a.id, a])), select } : null),
    [agents, select],
  )
  const wide = useMediaQuery(WIDE)
  const showMain = useCallback(() => select(MAIN), [select])

  return (
    // The thread scrolls; the bar over it and the follow-up box under it stay. The list of
    // agents is a column of its own beside both, so the box is centred under the thread.
    // Keyed by the job (CodePage): another job fades in where this one was.
    <div className="swap-in flex h-full flex-col">
      <TopBar thread={thread} backTo={backTo}
        switcher={nav && !wide ? <AgentSwitcher agents={agents} selected={selected} onSelect={select} /> : undefined} />
      <AgentNavContext.Provider value={nav}>
        <div className="flex min-h-0 flex-1">
          <div data-testid="code-thread-column" className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="relative min-h-0 flex-1">
              <div ref={scroller} className="h-full overflow-y-auto overscroll-contain">
                <div ref={content} className="mx-auto max-w-3xl px-2 pb-6 pt-4 md:px-6">
                  {detail.isPending && <DelayedLoading className="p-2 text-[13px]" />}
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
                        {thread.map((job, i) => (
                          <JobPart key={job.id} job={job} index={i} last={i === thread.length - 1} agent={selected} agents={perJob.get(job.id) ?? NO_AGENTS} onMain={showMain} />
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>
              {away && (
                <Button size="sm" icon={<ArrowDown className="h-3.5 w-3.5" />} className="absolute bottom-3 left-1/2 -translate-x-1/2 border border-border shadow-float"
                  onClick={() => toEnd(true)}>
                  {latest?.state === 'running' ? t('Jump to latest') : t('Jump to the end')}
                </Button>
              )}
            </div>
            {latest && <div className="shrink-0"><FollowUpBox job={latest} title={thread[0]?.title} onSent={toEnd} /></div>}
          </div>
          {nav && wide && <AgentSidebar agents={agents} selected={selected} onSelect={select} />}
        </div>
      </AgentNavContext.Provider>
    </div>
  )
}
