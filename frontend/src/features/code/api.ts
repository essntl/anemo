/**
 * The Code page's server state: Claude Code jobs, their threads and their events
 * (docs/specs/code-sessions.md §5.4), kept live by two streams (§5.2):
 *  - the app-wide stream's `code.job` notice refreshes everything under `codeKey`
 *    (features/chat/useAppEvents.ts);
 *  - a running job's own stream (`/api/code/jobs/{id}/stream`) brings its new events
 *    (`code.events`) and its changed row (`code.job`), see `useCodeEvents`.
 */
import { useEffect, useRef } from 'react'
import { type InfiniteData, type QueryClient, keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas, unwrap } from '@/api/client'
import type { CodeJob, CodeJobState } from './threads'
import { type CodeEvent, contiguousSeq, mergeEvents } from './timeline'

export type CodeJobList = Schemas['CodeJobListOut']
export type CodeJobDetail = Schemas['CodeJobDetailOut']

/** Every code query but the events (which a notice must not fetch again). */
export const codeKey = ['code'] as const
export const codeJobsKey = ['code', 'jobs'] as const
export const codeJobKey = (id: string) => ['code', 'job', id] as const
export const codeEventsKey = (id: string) => ['code-events', id] as const

export interface CodeFilters {
  project: string | null
  state: CodeJobState | null
}

const PAGE = 200

/** Jobs, newest first, page by page (`before` = the start of the last one). */
export function useCodeJobs(filters: CodeFilters) {
  return useInfiniteQuery({
    queryKey: [...codeJobsKey, filters],
    placeholderData: keepPreviousData,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET('/api/code/jobs', {
          params: {
            query: {
              limit: PAGE,
              ...(filters.project ? { project: filters.project } : {}),
              ...(filters.state ? { state: filters.state } : {}),
              ...(pageParam ? { before: pageParam } : {}),
            },
          },
        }),
      ),
    getNextPageParam: (last) => (last.has_more && last.jobs.length ? last.jobs[last.jobs.length - 1].started_at : null),
  })
}

/** A job and its whole thread. */
export function useCodeJob(id: string | null) {
  return useQuery({
    queryKey: codeJobKey(id ?? 'none'),
    enabled: Boolean(id),
    queryFn: async () => unwrap(await api.GET('/api/code/jobs/{job_id}', { params: { path: { job_id: id! } } })),
  })
}

const EVENTS_PAGE = 2000

/** Every event after `after`, as many pages as it takes. */
async function fetchEventsAfter(jobId: string, after: number): Promise<CodeEvent[]> {
  const out: CodeEvent[] = []
  let cursor = after
  for (;;) {
    const page = unwrap(
      await api.GET('/api/code/jobs/{job_id}/events', { params: { path: { job_id: jobId }, query: { after_seq: cursor, limit: EVENTS_PAGE } } }),
    )
    out.push(...page.events)
    const last = page.events.at(-1)?.seq
    if (!page.has_more || last === undefined || last <= cursor) return out
    cursor = last
  }
}

function eventsQuery(qc: QueryClient, jobId: string) {
  const queryKey = codeEventsKey(jobId)
  return {
    queryKey,
    // Kept fresh by the job's stream, not by fetching again.
    staleTime: Infinity,
    queryFn: async () => {
      const fetched = await fetchEventsAfter(jobId, 0)
      // Frames the stream brought while this was loading are kept.
      return mergeEvents(qc.getQueryData<CodeEvent[]>(queryKey) ?? [], fetched)
    },
  }
}

/** A job's new row, everywhere it is shown (its thread, the list). */
export function putJob(qc: QueryClient, job: CodeJob): void {
  qc.setQueriesData<CodeJobDetail>({ queryKey: ['code', 'job'] }, (old) =>
    old && (old.job.id === job.id || old.thread.some((j) => j.id === job.id))
      ? { job: old.job.id === job.id ? job : old.job, thread: old.thread.map((j) => (j.id === job.id ? job : j)) }
      : old,
  )
  qc.setQueriesData<InfiniteData<CodeJobList>>({ queryKey: codeJobsKey }, (old) =>
    old?.pages.some((p) => p.jobs.some((j) => j.id === job.id))
      ? { ...old, pages: old.pages.map((p) => ({ ...p, jobs: p.jobs.map((j) => (j.id === job.id ? job : j)) })) }
      : old,
  )
}

function parse(data: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(data)
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The fetch of a job's missing events now in flight, per query client: one at a time per job. */
const inFlight = new WeakMap<QueryClient, Map<string, { run: Promise<void>; again: boolean }>>()

/**
 * Fetches the events after the last one held without a gap (`events?after_seq=`) and
 * merges them. One fetch per job at a time: a call while one runs makes it go once
 * more when it is done, and waits for that.
 */
export function fetchMissingEvents(qc: QueryClient, jobId: string): Promise<void> {
  let jobs = inFlight.get(qc)
  if (!jobs) inFlight.set(qc, (jobs = new Map()))
  const running = jobs.get(jobId)
  if (running) {
    running.again = true
    return running.run
  }
  const options = eventsQuery(qc, jobId)
  const entry = { again: false, run: Promise.resolve() }
  const all = jobs
  entry.run = (async () => {
    try {
      // The first load (maybe still running) comes first: no need to fetch it twice.
      await qc.ensureQueryData(options)
      do {
        entry.again = false
        const have = contiguousSeq(qc.getQueryData<CodeEvent[]>(options.queryKey) ?? [])
        const events = await fetchEventsAfter(jobId, have)
        qc.setQueryData<CodeEvent[]>(options.queryKey, (old) => mergeEvents(old ?? [], events))
      } while (entry.again)
    } catch {
      // Offline for a moment: the next frame, notice or reconnect tries again.
    } finally {
      all.delete(jobId)
    }
  })()
  jobs.set(jobId, entry)
  return entry.run
}

/**
 * A job's events.
 *
 * Whenever the job's `last_seq` (the server's last stored seq without a gap, from a
 * `code.job` frame or from the job's row after a refresh) is past what is held, the
 * rest is fetched: for a running job and for a finished one (a job back-filled after
 * it ended, a frame that was never published, a stream that only sends snapshots).
 *
 * While `live` (the job runs), its stream is open: on every (re)open the missing
 * events are fetched, and again when a frame starts past a gap. The stream closes once
 * the job has ended (after one last fetch for anything still missing).
 */
export function useCodeEvents(jobId: string, { live, lastSeq }: { live: boolean; lastSeq?: number }) {
  const qc = useQueryClient()
  const query = useQuery(eventsQuery(qc, jobId))

  // Held without a gap; null until the first load is in.
  const have = query.data ? contiguousSeq(query.data) : null
  // The last (held, last_seq) pair a fetch was made for: a fetch that brought nothing
  // new is not repeated until either moves.
  const tried = useRef('')
  useEffect(() => {
    if (have === null || lastSeq === undefined || lastSeq <= have) return
    const attempt = `${jobId}:${have}:${lastSeq}`
    if (tried.current === attempt) return
    tried.current = attempt
    void fetchMissingEvents(qc, jobId)
  }, [qc, jobId, have, lastSeq])

  useEffect(() => {
    if (!live) return
    const key = codeEventsKey(jobId)
    const current = () => qc.getQueryData<CodeEvent[]>(key) ?? []
    const catchUp = () => fetchMissingEvents(qc, jobId)
    const source = new EventSource(`/api/code/jobs/${encodeURIComponent(jobId)}/stream`)
    source.addEventListener('open', () => void catchUp())
    source.addEventListener('code.events', ((e: MessageEvent<string>) => {
      const events = parse(e.data)?.events
      if (!Array.isArray(events) || events.length === 0) return
      const held = contiguousSeq(current())
      qc.setQueryData<CodeEvent[]>(key, (old) => mergeEvents(old ?? [], events as CodeEvent[]))
      const first = Math.min(...(events as CodeEvent[]).map((ev) => ev.seq))
      if (first > held + 1) void catchUp()
    }) as EventListener)
    // The job's row: its new last_seq reaches the effect above through the caches.
    source.addEventListener('code.job', ((e: MessageEvent<string>) => {
      const job = parse(e.data)?.job as CodeJob | undefined
      if (!job || typeof job.id !== 'string') return
      putJob(qc, job)
      if (job.id === jobId && job.state !== 'running') {
        void catchUp().finally(() => source.close())
      }
    }) as EventListener)
    return () => source.close()
  }, [jobId, live, qc])

  return query
}
