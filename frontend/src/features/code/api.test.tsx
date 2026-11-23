import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/api/client'
import { useCodeJobs } from './api'
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
