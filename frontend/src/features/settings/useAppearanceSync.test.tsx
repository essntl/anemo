import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/* frontend-3: a theme just picked must not come back as the old one when the layout
 * is mounted again. */
const saved = vi.hoisted(() => ({ calls: [] as { accent: string }[] }))

vi.mock('./api', async () => {
  const { useQuery } = await import('@tanstack/react-query')
  return {
    settingsKey: ['settings'],
    useSettings: () => useQuery({ queryKey: ['settings'], queryFn: () => new Promise(() => {}) }),
    saveAppearance: async (a: { mode: string; accent: string; density: string }) => {
      saved.calls.push(a)
      return a
    },
  }
})

const { useAppearanceSync, resetAppearanceSync } = await import('./useAppearanceSync')
const { useThemeStore } = await import('./theme')

const SERVER = { mode: 'dark', accent: '#3478f6', density: 'comfortable' }

function setup() {
  const qc = new QueryClient()
  qc.setQueryData(['settings'], { appearance: SERVER })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  return { qc, wrapper }
}

describe('appearance sync', () => {
  beforeEach(() => {
    saved.calls = []
    resetAppearanceSync()
    vi.useFakeTimers()
  })

  it('saves a change after a pause and keeps the cached settings current', async () => {
    const { qc, wrapper } = setup()
    renderHook(() => useAppearanceSync(), { wrapper })
    useThemeStore.getState().set({ accent: '#e0457b' })
    await vi.advanceTimersByTimeAsync(600)
    expect(saved.calls.map((c) => c.accent)).toEqual(['#e0457b'])
    expect((qc.getQueryData(['settings']) as { appearance: { accent: string } }).appearance.accent).toBe('#e0457b')
  })

  it('a change made just before leaving is still saved', async () => {
    const { wrapper } = setup()
    const view = renderHook(() => useAppearanceSync(), { wrapper })
    useThemeStore.getState().set({ accent: '#00aa55' })
    view.unmount()
    await vi.advanceTimersByTimeAsync(0)
    expect(saved.calls.map((c) => c.accent)).toEqual(['#00aa55'])
  })

  it('mounting again does not bring back the old value', async () => {
    const { wrapper } = setup()
    const first = renderHook(() => useAppearanceSync(), { wrapper })
    useThemeStore.getState().set({ accent: '#123456' })
    first.unmount()
    renderHook(() => useAppearanceSync(), { wrapper })
    await vi.advanceTimersByTimeAsync(600)
    expect(useThemeStore.getState().accent).toBe('#123456')
  })
})
