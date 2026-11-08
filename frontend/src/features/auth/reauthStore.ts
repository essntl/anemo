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
  /** Everyone waiting for the password (one dialog answers them all); null when none. */
  pending: ((ok: boolean) => void)[] | null
  request: () => Promise<boolean>
  resolve: (ok: boolean) => void
}

export const useReauthStore = create<ReauthStore>((set, get) => ({
  pending: null,
  // Two changes that need the password at the same time share the one dialog, and both
  // go on (or both stop) with its answer.
  request: () => new Promise<boolean>((resolve) => set({ pending: [...(get().pending ?? []), resolve] })),
  resolve: (ok) => {
    const waiting = get().pending ?? []
    set({ pending: null })
    for (const done of waiting) done(ok)
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
