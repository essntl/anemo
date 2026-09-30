/**
 * Password confirmation for security-sensitive changes.
 *
 * The backend rejects sensitive changes with code `reauth_required` unless the
 * password was entered recently. Wrap such calls with `withReauth`:
 *
 *   await withReauth(() => saveProvider(data))
 *
 * On `reauth_required` it shows <ReauthDialog/>, and retries once after success.
 */
import { create } from 'zustand'
import { ApiError } from '@/api/client'

interface ReauthStore {
  pending: ((ok: boolean) => void) | null
  request: () => Promise<boolean>
  resolve: (ok: boolean) => void
}

export const useReauthStore = create<ReauthStore>((set, get) => ({
  pending: null,
  request: () => new Promise<boolean>((resolve) => set({ pending: resolve })),
  resolve: (ok) => {
    get().pending?.(ok)
    set({ pending: null })
  },
}))

export async function withReauth<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (!(err instanceof ApiError && err.code === 'reauth_required')) throw err
    const ok = await useReauthStore.getState().request()
    if (!ok) throw err
    return fn()
  }
}
