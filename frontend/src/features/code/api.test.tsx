import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/api/client'
import { ApiError } from '@/api/client'
import { type CodeJobDetail, codeKey, codeJobKey, mayHaveStarted, useCancelJob, useCodeJobs, useFollowUp, useStartJob } from './api'
import { codeJob } from './testJobs'

afterEach(() => vi.restoreAllMocks())

describe('useCodeJobs', () => {
  it('asks for the next page after the last row, by its start and id', async () => {
    // Two jobs that started in the same second, one on each side of the page boundary.
    const first = [codeJob({ id: 'a', started_at: '2026-11-23T10:00:00Z' }), codeJob({ id: 'b', started_at: '2026-11-23T09:00:00Z' })]
    const second = [codeJob({ id: 'c', started_at: '2026-11-23T09:00:00Z' })]
    const asked: Record<string, unknown>[] = []
    vi.spyOn(api, 'GET').mockImplementation((async (_path: string, init: { params: { query: Record<string, unknown> } }) => {
      asked.push(init.params.query)
      const page = asked.length === 1 ? { jobs: first, has_more: true } : { jobs: second, has_more: false }
      return { data: { ...page, projects: ['anemo'] }, response: { ok: true, status: 200 } as Response }
    }) as unknown as typeof api.GET)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    const { result } = renderHook(() => useCodeJobs({ project: 'anemo', state: null }), { wrapper })

    await waitFor(() => expect(result.current.hasNextPage).toBe(true))
    expect(asked[0]).toEqual({ limit: 200, project: 'anemo' })
    await act(async () => void (await result.current.fetchNextPage()))
    expect(asked[1]).toEqual({ limit: 200, project: 'anemo', before: '2026-11-23T09:00:00Z', before_id: 'b' })
    await waitFor(() => expect(result.current.hasNextPage).toBe(false))
    expect(result.current.data?.pages.flatMap((p) => p.jobs.map((j) => j.id))).toEqual(['a', 'b', 'c'])
  })
})

describe('starting, following up and cancelling', () => {
  const ok = { ok: true, status: 201 } as Response
  function setup() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    return { client, wrapper }
  }
  const posted: { path: string; init: unknown }[] = []
  function answer(job: unknown) {
    posted.length = 0
    vi.spyOn(api, 'POST').mockImplementation((async (path: string, init: unknown) => {
      posted.push({ path, init })
      return { data: job, response: ok }
    }) as unknown as typeof api.POST)
  }

  it('starts a job: its thread is ready to open', async () => {
    const job = codeJob({ id: 'new', state: 'running' })
    answer(job)
    const { client, wrapper } = setup()
    const { result } = renderHook(() => useStartJob(), { wrapper })
    await act(async () => void (await result.current.mutateAsync({ device_id: 'dev-1', project: 'anemo', prompt: 'Go', new: false, model: null })))
    expect(posted).toEqual([{ path: '/api/code/jobs', init: { body: { device_id: 'dev-1', project: 'anemo', prompt: 'Go', new: false, model: null } } }])
    expect(client.getQueryData<CodeJobDetail>(codeJobKey('new'))).toEqual({ job, thread: [job], messages: [] })
  })

  it('follows up: the new job joins the open thread', async () => {
    const first = codeJob({ id: 'a', state: 'done', session_id: 's1' })
    const next = codeJob({ id: 'b', thread_id: 'a', state: 'running', resume_session: 's1' })
    answer(next)
    const { client, wrapper } = setup()
    client.setQueryData<CodeJobDetail>(codeJobKey('a'), { job: first, thread: [first], messages: [] })
    const { result } = renderHook(() => useFollowUp('a'), { wrapper })
    await act(async () => void (await result.current.mutateAsync({ prompt: 'More' })))
    // Without images the request has no image_ids at all.
    expect(posted).toEqual([{ path: '/api/code/jobs/{job_id}/follow-up', init: { params: { path: { job_id: 'a' } }, body: { prompt: 'More' } } }])
    expect(client.getQueryData<CodeJobDetail>(codeJobKey('a'))?.thread.map((j) => j.id)).toEqual(['a', 'b'])
  })

  it('follows up with images: their ids go with the prompt', async () => {
    answer(codeJob({ id: 'b', thread_id: 'a' }))
    const { wrapper } = setup()
    const { result } = renderHook(() => useFollowUp('a'), { wrapper })
    const images = [{ id: 'att-1', name: 'shot.png', size: 10 }, { id: 'att-2', name: 'b.jpg', size: 20 }]
    await act(async () => void (await result.current.mutateAsync({ prompt: 'Like this', images })))
    expect(posted[0].init).toEqual({ params: { path: { job_id: 'a' } }, body: { prompt: 'Like this', image_ids: ['att-1', 'att-2'] } })
  })

  it('refreshes the jobs and computers when a start may have happened, not on a plain refusal', async () => {
    const { client, wrapper } = setup()
    const refresh = vi.spyOn(client, 'invalidateQueries')
    let fail: unknown = new ApiError(504, 'http_504', 'Gateway Timeout')
    vi.spyOn(api, 'POST').mockImplementation((async () => { throw fail }) as unknown as typeof api.POST)
    const { result } = renderHook(() => useStartJob(), { wrapper })
    const body = { device_id: 'd', project: 'p', prompt: 'x', new: false, model: null }
    await act(async () => void (await result.current.mutateAsync(body).catch(() => {})))
    expect(refresh).toHaveBeenCalledWith({ queryKey: codeKey })
    refresh.mockClear()
    fail = new ApiError(409, 'device_busy', 'Busy.')
    await act(async () => void (await result.current.mutateAsync(body).catch(() => {})))
    expect(refresh).not.toHaveBeenCalled()
  })

  it('knows which failures may hide a start', () => {
    expect(mayHaveStarted(new ApiError(504, 'http_504', ''))).toBe(true)
    expect(mayHaveStarted(new ApiError(502, 'http_502', ''))).toBe(true)
    expect(mayHaveStarted(new TypeError('Failed to fetch'))).toBe(true)
    for (const code of ['device_offline', 'device_busy', 'code_start_off', 'device_failed']) {
      expect(mayHaveStarted(new ApiError(409, code, ''))).toBe(false)
    }
  })

  it('cancels: the job shows its new state', async () => {
    const running = codeJob({ id: 'r', state: 'running' })
    answer({ ...running, state: 'cancelled' })
    const { client, wrapper } = setup()
    client.setQueryData<CodeJobDetail>(codeJobKey('r'), { job: running, thread: [running], messages: [] })
    const { result } = renderHook(() => useCancelJob(), { wrapper })
    await act(async () => void (await result.current.mutateAsync('r')))
    expect(posted[0].path).toBe('/api/code/jobs/{job_id}/cancel')
    expect(client.getQueryData<CodeJobDetail>(codeJobKey('r'))?.thread[0].state).toBe('cancelled')
  })
})
