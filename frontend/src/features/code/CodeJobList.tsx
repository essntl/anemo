/**
 * The list of the Code page (docs/specs/code-sessions.md §7.2): one row per thread,
 * showing its latest job, grouped by project; filters by project and state, kept in
 * the address. Refreshed by the app-wide `code.job` notice (features/chat/useAppEvents.ts).
 */
import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router'
import { GitBranch, GitPullRequest, SquareTerminal } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Elapsed } from '@/components/ui/Elapsed'
import { EmptyState } from '@/components/ui/EmptyState'
import { Select } from '@/components/ui/Select'
import { cn } from '@/lib/cn'
import { formatCost, formatDuration, formatWhen } from '@/lib/format'
import { msg, plural, t } from '@/lib/i18n'
import { type CodeFilters, useCodeJobs } from './api'
import { StateBadge } from './parts'
import { type CodeJobState, type CodeThread, JOB_STATES, groupByProject, jobDurationMs, pullRequest, toThreads } from './threads'

const STATE_FILTER: Record<CodeJobState, string> = {
  running: msg('Running'),
  done: msg('Done'),
  failed: msg('Failed'),
  cancelled: msg('Cancelled'),
  exited_without_result: msg('Exited without result'),
}

/** The filters as the address has them (`?project=…&state=…`). */
function filtersOf(params: URLSearchParams): CodeFilters {
  const state = params.get('state')
  return {
    project: params.get('project') || null,
    state: JOB_STATES.includes(state as CodeJobState) ? (state as CodeJobState) : null,
  }
}

function ThreadRow({ thread, selected, search }: { thread: CodeThread; selected: boolean; search: string }) {
  const job = thread.latest
  const running = job.state === 'running'
  const ms = jobDurationMs(job)
  const pr = pullRequest(job.pr_url ?? thread.jobs.map((j) => j.pr_url).filter(Boolean).at(-1))
  const branch = job.branch
  const followUps = thread.jobs.length - 1
  return (
    <li>
      <Link to={`/code/${job.id}${search}`} aria-current={selected ? 'page' : undefined} data-testid="code-thread"
        className={cn('block rounded-lg px-3 py-2 hover:bg-surface-hover', selected && 'bg-accent-soft hover:bg-accent-soft')}>
        <div className="flex min-w-0 items-start gap-2">
          <span className="min-w-0 flex-1 break-words text-[13.5px] font-medium leading-snug [overflow-wrap:anywhere] line-clamp-2">{thread.first.title || t('(no title)')}</span>
          <StateBadge state={job.state} />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-muted tabular-nums">
          <span className="min-w-0 truncate">
            {job.device.name}
            {!job.device.online && <span className="text-warning"> · {t('offline')}</span>}
          </span>
          <span>{t('started {when}', { when: formatWhen(job.started_at) })}</span>
          {running ? <Elapsed since={job.started_at} /> : ms !== null && <span>{formatDuration(ms / 1000)}</span>}
          {thread.turns !== null && <span>{plural(thread.turns, '{n} turn', '{n} turns')}</span>}
          {thread.costUsd !== null && (
            <span title={t('API-equivalent cost: what these tokens would cost on the API, not money spent')}>
              {t('{cost} API-equivalent', { cost: formatCost(thread.costUsd) })}
            </span>
          )}
        </div>
        {(branch || pr || followUps > 0) && (
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px]">
            {branch && (
              <span className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-muted">
                <GitBranch aria-hidden="true" className="h-3 w-3 shrink-0" /><span className="truncate font-mono">{branch}</span>
              </span>
            )}
            {pr && (
              <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-muted">
                <GitPullRequest aria-hidden="true" className="h-3 w-3 shrink-0" />#{pr.number}
              </span>
            )}
            {followUps > 0 && <span className="text-subtle">{plural(followUps, '{n} follow-up', '{n} follow-ups')}</span>}
          </div>
        )}
      </Link>
    </li>
  )
}

function Skeleton() {
  return (
    <div aria-busy="true" aria-label={t('Loading…')} className="space-y-2 px-3 py-2">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="space-y-1.5 rounded-lg py-1">
          <div className="h-3.5 w-3/4 animate-pulse rounded bg-surface-2" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-surface-2" />
        </div>
      ))}
    </div>
  )
}

/** The list. `jobId` is the open job (its thread is marked). */
export function CodeJobList({ jobId }: { jobId?: string }) {
  const [params, setParams] = useSearchParams()
  const filters = filtersOf(params)
  const jobs = useCodeJobs(filters)
  const pages = jobs.data?.pages
  const groups = useMemo(() => groupByProject(toThreads(pages?.flatMap((p) => p.jobs) ?? [])), [pages])
  const projects = useMemo(() => {
    const names = new Set(pages?.flatMap((p) => p.projects) ?? [])
    if (filters.project) names.add(filters.project)
    return [...names].sort((a, b) => a.localeCompare(b))
  }, [pages, filters.project])
  const search = params.toString() ? `?${params.toString()}` : ''
  const filtered = Boolean(filters.project || filters.state)

  const setFilter = (name: 'project' | 'state', value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(name, value)
    else next.delete(name)
    setParams(next, { replace: true })
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap gap-2 border-b border-border px-3 py-2">
        <Select variant="pill" aria-label={t('Project')} value={filters.project ?? ''} onValueChange={(v) => setFilter('project', v)}
          options={[{ value: '', label: t('All projects') }, ...projects.map((p) => ({ value: p, label: p }))]} />
        <Select variant="pill" aria-label={t('State')} value={filters.state ?? ''} onValueChange={(v) => setFilter('state', v)}
          options={[{ value: '', label: t('All states') }, ...JOB_STATES.map((s) => ({ value: s, label: t(STATE_FILTER[s]) }))]} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-4">
        {jobs.isPending ? <Skeleton /> : jobs.isError ? (
          <div className="p-4 text-[13px]">
            <p className="text-error">{errorMessage(jobs.error)}</p>
            <Button size="sm" className="mt-2" onClick={() => void jobs.refetch()}>{t('Try again')}</Button>
          </div>
        ) : groups.length === 0 ? (
          filtered ? (
            <EmptyState title={t('No jobs match these filters')}
              action={<Button size="sm" onClick={() => setParams(new URLSearchParams(), { replace: true })}>{t('Clear filters')}</Button>} />
          ) : (
            <EmptyState icon={<SquareTerminal className="h-5 w-5" />} title={t('No Claude Code jobs yet')}
              description={t('Turn on “Share Claude Code jobs with Anemo” in Anemo Desktop on a computer you trust (Settings → Devices), and the jobs that run on it show up here.')}
              action={<Link to="/settings/devices"><Button size="sm">{t('Open Devices')}</Button></Link>} />
          )
        ) : (
          <>
            {groups.map((group) => (
              <section key={group.project} aria-label={group.project} className="pt-2">
                <h3 className="flex items-center gap-2 px-4 pb-1 pt-1 text-[11.5px] font-semibold uppercase tracking-wider text-subtle">
                  <span className="min-w-0 truncate normal-case tracking-normal text-[12.5px] text-muted">{group.project}</span>
                  <span className="tabular-nums">{group.threads.length}</span>
                </h3>
                <ul className="px-1.5">
                  {group.threads.map((thread) => (
                    <ThreadRow key={thread.id} thread={thread} search={search}
                      selected={Boolean(jobId && thread.jobs.some((j) => j.id === jobId))} />
                  ))}
                </ul>
              </section>
            ))}
            {jobs.hasNextPage && (
              <div className="px-3 pt-2">
                <Button size="sm" variant="ghost" loading={jobs.isFetchingNextPage} onClick={() => void jobs.fetchNextPage()}>{t('Show older jobs')}</Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
