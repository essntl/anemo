/**
 * The Code page's server state: Claude Code jobs, their threads and their events
 * (docs/specs/code-sessions.md §5.4), kept live by two streams (§5.2):
 *  - the app-wide stream's `code.job` notice refreshes everything under `codeKey`
 *    (features/chat/useAppEvents.ts);
 *  - a running job's own stream (`/api/code/jobs/{id}/stream`) brings its new events
 *    (`code.events`) and its changed row (`code.job`), see `useCodeEvents`.
 * Phase 2 (§12): the computers, their projects, and starting, following up and
 * cancelling jobs.
 */
import { useCallback, useEffect, useRef } from 'react'
import { type InfiniteData, type QueryClient, keepPreviousData, useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, api, errorMessage, type Schemas, unwrap } from '@/api/client'
import { t } from '@/lib/i18n'
import { type CodeImage, imageIds } from './codeImages'
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

/** Where the next page starts: after the last row, by (started_at, id) so jobs that started together aren't skipped. */
type Cursor = { before: string; before_id: string }

/** Jobs, newest first, page by page. */
export function useCodeJobs(filters: CodeFilters) {
  return useInfiniteQuery({
    queryKey: [...codeJobsKey, filters],
    placeholderData: keepPreviousData,
    initialPageParam: null as Cursor | null,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET('/api/code/jobs', {
          params: {
            query: {
              limit: PAGE,
              ...(filters.project ? { project: filters.project } : {}),
              ...(filters.state ? { state: filters.state } : {}),
              ...(pageParam ? { before: pageParam.before, before_id: pageParam.before_id } : {}),
            },
          },
        }),
      ),
    getNextPageParam: (last): Cursor | null => {
      const end = last.jobs.at(-1)
      return last.has_more && end ? { before: end.started_at, before_id: end.id } : null
    },
  })
}

/** A job and its whole thread. */
function jobQuery(id: string) {
  return {
    queryKey: codeJobKey(id),
    queryFn: async () => unwrap(await api.GET('/api/code/jobs/{job_id}', { params: { path: { job_id: id } } })),
  }
}

export function useCodeJob(id: string | null) {
  return useQuery({ ...jobQuery(id ?? 'none'), enabled: Boolean(id) })
}

/** Loads a job and its events before it is opened (the list, on hover or focus), so
 * opening it shows it at once. Data already loaded and recent is not fetched again. */
export function usePrefetchCodeJob(): (id: string) => void {
  const qc = useQueryClient()
  return useCallback((id: string) => {
    void qc.prefetchQuery({ ...jobQuery(id), staleTime: 30_000 })
    void qc.prefetchQuery(eventsQuery(qc, id))
  }, [qc])
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

/**
 * The events of several jobs (a thread's), by job id, as far as they are loaded. The
 * same queries as `useCodeEvents`, so nothing is fetched twice: each job's part of the
 * thread keeps its own events live, and this only reads them (for the sub-agent list).
 */
export function useThreadEvents(jobIds: readonly string[]): Record<string, CodeEvent[]> {
  const qc = useQueryClient()
  const key = jobIds.join(',')
  // A stable `combine`: the result is a new object only when some job's events changed.
  const combine = useCallback(
    (results: { data?: CodeEvent[] }[]) => Object.fromEntries(key.split(',').map((id, i) => [id, results[i]?.data ?? []])),
    [key],
  )
  return useQueries({ queries: jobIds.map((id) => eventsQuery(qc, id)), combine })
}

/**
 * A job's new row, everywhere it is shown: its thread (a follow-up joins the thread it
 * belongs to) and the list.
 */
export function putJob(qc: QueryClient, job: CodeJob): void {
  qc.setQueriesData<CodeJobDetail>({ queryKey: ['code', 'job'] }, (old) => {
    if (!old) return old
    const inThread = old.thread.some((j) => j.id === job.id)
    const joins = !inThread && old.thread.some((j) => j.thread_id === job.thread_id)
    if (!inThread && !joins && old.job.id !== job.id) return old
    return {
      ...old,
      job: old.job.id === job.id ? job : old.job,
      thread: inThread ? old.thread.map((j) => (j.id === job.id ? job : j)) : joins ? [...old.thread, job] : old.thread,
    }
  })
  qc.setQueriesData<InfiniteData<CodeJobList>>({ queryKey: codeJobsKey }, (old) =>
    old?.pages.some((p) => p.jobs.some((j) => j.id === job.id))
      ? { ...old, pages: old.pages.map((p) => ({ ...p, jobs: p.jobs.map((j) => (j.id === job.id ? job : j)) })) }
      : old,
  )
}

// ---- Phase 2: starting, following up and cancelling jobs (§12.2) ----

const fetchDevices = async () => unwrap(await api.GET('/api/code/devices'))
const fetchProjects = async (deviceId: string) =>
  unwrap(await api.GET('/api/code/devices/{device_id}/projects', { params: { path: { device_id: deviceId } } }))

/** A trusted computer, and whether it shares jobs and lets Anemo start them. */
export type CodeDevice = Awaited<ReturnType<typeof fetchDevices>>[number]
/** A computer's projects: local folders, its owner's repositories not cloned yet, and why that list is missing. */
export type CodeProjects = Awaited<ReturnType<typeof fetchProjects>>
export type CodeModel = 'opus' | 'sonnet' | 'haiku'

export const codeDevicesKey = ['code', 'devices'] as const
/** Not under `codeKey`: asking a computer for its projects runs a command there (up to 45 s). */
export const codeProjectsKey = (deviceId: string) => ['code-projects', deviceId] as const

/** The trusted computers (refreshed by the app-wide notice, like the jobs). */
export function useCodeDevices(enabled = true) {
  return useQuery({ queryKey: codeDevicesKey, enabled, queryFn: fetchDevices })
}

/** A computer's projects, asked of the computer itself. */
export function useCodeProjects(deviceId: string | null) {
  return useQuery({
    queryKey: codeProjectsKey(deviceId ?? 'none'),
    enabled: Boolean(deviceId),
    staleTime: 60_000,
    retry: false,
    queryFn: () => fetchProjects(deviceId!),
  })
}

/** Not under `codeKey`: refreshed by its own app-wide notice (`code.usage`), not by every job's. */
export const codeUsageKey = ['code-usage'] as const

/** The latest known usage of each computer's Claude subscription (§14), kept while no job runs. */
export function useCodeUsage() {
  return useQuery({
    queryKey: codeUsageKey,
    // The reset times pass by themselves: look again now and then.
    refetchInterval: 5 * 60_000,
    queryFn: async () => unwrap(await api.GET('/api/code/usage')).usage,
  })
}

export interface StartJobInput {
  device_id: string
  project: string
  prompt: string
  new: boolean
  model: CodeModel | null
  /** Uploaded images to send with the prompt (codeImages.ts). */
  image_ids?: string[]
}

/** Starts a job on a computer. The new job is a thread of its own, followed live like any running job. */
export function useStartJob() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (body: StartJobInput) => unwrap(await api.POST('/api/code/jobs', { body })),
    onSuccess: (job) => {
      qc.setQueryData<CodeJobDetail>(codeJobKey(job.id), { job, thread: [job], messages: [] })
      void qc.invalidateQueries({ queryKey: codeJobsKey })
    },
    onError: (err) => refreshIfStarted(qc, err),
  })
}

/**
 * Whether a start may have happened although it failed here: the answer never came (a
 * gateway gave up, 502/504, or the connection dropped), while the computer may have
 * started the job.
 */
export function mayHaveStarted(err: unknown): boolean {
  return err instanceof ApiError ? err.status === 502 || err.status === 504 : true
}

/** What to say when starting (a job or a follow-up) failed: the server's message, or that it may have started. */
export function startErrorMessage(err: unknown): string {
  return mayHaveStarted(err) ? t('No answer came in time: the job may have started anyway. The list is being refreshed.') : errorMessage(err)
}

/** After a start that may have happened: the jobs (and threads) and computers load again. */
function refreshIfStarted(qc: QueryClient, err: unknown): void {
  if (!mayHaveStarted(err)) return
  void qc.invalidateQueries({ queryKey: codeKey })
}

/**
 * Resumes the thread of `jobId` with a new prompt (and its images): the new job joins the
 * thread, live. (Also called outside a component: the queue sends a message when its job
 * has ended.)
 */
export async function sendFollowUp(qc: QueryClient, jobId: string, prompt: string, images: readonly CodeImage[] = []): Promise<CodeJob> {
  try {
    const job = unwrap(await api.POST('/api/code/jobs/{job_id}/follow-up', {
      params: { path: { job_id: jobId } },
      body: { prompt, ...imageIds(images) },
    }))
    putJob(qc, job)
    void qc.invalidateQueries({ queryKey: codeKey })
    return job
  } catch (err) {
    refreshIfStarted(qc, err)
    throw err
  }
}

export function useFollowUp(jobId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ prompt, images = [] }: { prompt: string; images?: readonly CodeImage[] }) => sendFollowUp(qc, jobId, prompt, images),
  })
}

export type CodeMessage = Schemas['CodeMessageOut']

/** Not delivered yet: what the thread shows over its box (and what a cancel would send as a follow-up). */
export const isWaiting = (m: CodeMessage) => m.state === 'queued' || m.state === 'sending' || m.state === 'sent' || m.state === 'held'

/** The thread's messages (§15), from the thread's query (which the app-wide notices keep fresh). */
export function useThreadMessages(jobId: string): CodeMessage[] {
  return useCodeJob(jobId).data?.messages ?? NO_MESSAGES
}
const NO_MESSAGES: CodeMessage[] = []

/** A message changed: the thread (with its messages) and the lists load again. */
const messagesChanged = (qc: QueryClient) => void qc.invalidateQueries({ queryKey: codeKey })

/**
 * A message for the thread of `jobId` (§15): handed to its running job, which takes it in
 * at its next step (`now`: after interrupting the current one), or the next follow-up.
 * (Also called outside a component: an older browser queue is moved to the server.)
 */
export async function sendMessage(qc: QueryClient, jobId: string, prompt: string, images: readonly CodeImage[] = [], now = false): Promise<CodeMessage> {
  try {
    return unwrap(await api.POST('/api/code/jobs/{job_id}/messages', {
      params: { path: { job_id: jobId } },
      body: { prompt, ...imageIds(images), ...(now ? { now: true } : {}) },
    }))
  } finally {
    messagesChanged(qc)
  }
}

export function useSendMessage(jobId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ prompt, images = [], now = false }: { prompt: string; images?: readonly CodeImage[]; now?: boolean }) =>
      sendMessage(qc, jobId, prompt, images, now),
  })
}

/** Removes a message that wasn't delivered (the job gives back one it holds); 409 once Claude Code took it in. */
export function useRemoveMessage() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (messageId: string) =>
      unwrap(await api.DELETE('/api/code/messages/{message_id}', { params: { path: { message_id: messageId } } })),
    onSettled: () => messagesChanged(qc),
  })
}

/** Sends a waiting (or held) message now: interrupting the job's step, or as a follow-up when the job has ended. */
export function useSendMessageNow() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (messageId: string) =>
      unwrap(await api.POST('/api/code/messages/{message_id}/now', { params: { path: { message_id: messageId } } })),
    onSettled: () => messagesChanged(qc),
  })
}

/** Auto continue for a job that stopped at the usage limit (§16): on schedules its continue, off cancels it. */
export function useAutoContinue() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ jobId, enabled }: { jobId: string; enabled: boolean }) =>
      unwrap(await api.PUT('/api/code/jobs/{job_id}/auto-continue', { params: { path: { job_id: jobId } }, body: { enabled } })),
    onSuccess: (job) => putJob(qc, job),
  })
}

/** Cancels a running job (one that has ended comes back as it is). */
export function useCancelJob() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (jobId: string) =>
      unwrap(await api.POST('/api/code/jobs/{job_id}/cancel', { params: { path: { job_id: jobId } } })),
    onSuccess: (job) => {
      putJob(qc, job)
      void qc.invalidateQueries({ queryKey: codeKey })
    },
  })
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
