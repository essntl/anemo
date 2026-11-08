import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

/* frontend-5: a layout change made just before leaving Home must still be saved. */
const puts = vi.hoisted(() => ({ bodies: [] as unknown[] }))

vi.mock('@/api/client', () => ({
  api: { PUT: async (_path: string, init: { body: unknown }) => { puts.bodies.push(init.body); return { data: init.body } } },
  unwrap: (r: { data: unknown }) => r.data,
}))
vi.mock('@/hooks/useMediaQuery', () => ({ DESKTOP: 'desktop', useMediaQuery: () => true }))
vi.mock('@/features/settings/api', async () => {
  const { useQuery } = await import('@tanstack/react-query')
  return {
    settingsKey: ['settings'],
    useSettings: () => useQuery({ queryKey: ['settings'], queryFn: () => new Promise(() => {}) }),
  }
})

const { useHomeLayout } = await import('./useHomeLayout')

describe('the Home layout', () => {
  it('is saved when Home is left right after a change', async () => {
    vi.useFakeTimers()
    const qc = new QueryClient()
    qc.setQueryData(['settings'], { home: { layout: [], mobile_layout: [] } })
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    const view = renderHook(() => useHomeLayout(), { wrapper })
    act(() => view.result.current.update((layout) => layout.map((w, i) => (i === 0 ? { ...w, hidden: true } : w))))
    view.unmount() // before the half-second pause is over
    await vi.advanceTimersByTimeAsync(0)
    expect(puts.bodies).toHaveLength(1)
    vi.useRealTimers()
  })
})
