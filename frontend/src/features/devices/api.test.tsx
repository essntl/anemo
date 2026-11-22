import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

/* Changing the trust level is security-sensitive: without a recent password the server
   answers reauth_required, the password dialog opens, and the change is sent again. */
const put = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>()
  return { ...actual, api: { ...actual.api, PUT: put } }
})

const { useSetTrust } = await import('./api')
const { useReauthStore } = await import('@/features/auth/reauthStore')

const response = (status: number) => ({ ok: status < 400, status, url: 'http://x/api/devices/d1/trust', statusText: '' }) as Response

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('useSetTrust', () => {
  it('asks for the password, then sends the change again', async () => {
    put
      .mockResolvedValueOnce({ error: { error: { code: 'reauth_required', message: 'Confirm' } }, response: response(403) })
      .mockResolvedValueOnce({ data: { id: 'd1', trust: 'trusted' }, response: response(200) })
    const { result } = renderHook(() => useSetTrust(), { wrapper })
    act(() => result.current.mutate({ id: 'd1', trust: 'trusted' }))
    await waitFor(() => expect(useReauthStore.getState().pending).not.toBeNull())
    act(() => useReauthStore.getState().resolve(true))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(put).toHaveBeenCalledTimes(2)
    expect(put).toHaveBeenLastCalledWith('/api/devices/{device_id}/trust', { params: { path: { device_id: 'd1' } }, body: { trust: 'trusted' } })
  })

  it('changes nothing when the password is not given', async () => {
    put.mockReset()
    put.mockResolvedValue({ error: { error: { code: 'reauth_required', message: 'Confirm' } }, response: response(403) })
    const { result } = renderHook(() => useSetTrust(), { wrapper })
    act(() => result.current.mutate({ id: 'd1', trust: 'trusted' }))
    await waitFor(() => expect(useReauthStore.getState().pending).not.toBeNull())
    act(() => useReauthStore.getState().resolve(false))
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(put).toHaveBeenCalledTimes(1)
  })
})
