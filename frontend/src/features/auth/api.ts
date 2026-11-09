import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, unwrap } from '@/api/client'
import { withReauth } from './reauthStore'

export const meKey = ['auth', 'me'] as const

/** The current session, or `null` when logged out. */
export function useMe() {
  return useQuery({
    queryKey: meKey,
    queryFn: async () => {
      try {
        return unwrap(await api.GET('/api/auth/me'))
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null
        throw err
      }
    },
    staleTime: 5 * 60_000,
  })
}

export function useLogin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (body: { username: string; password: string }) =>
      unwrap(await api.POST('/api/auth/login', { body })),
    onSuccess: (me) => {
      qc.clear()
      qc.setQueryData(meKey, me)
    },
  })
}

export function useLogout() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => unwrap(await api.POST('/api/auth/logout')),
    // A fresh page load at the login page: nothing of the session stays in memory
    // (cached data, live streams). Only clearing the cache left the page open but
    // empty, as the app still watched the "who am I" entry the clear had dropped.
    onSettled: () => {
      qc.clear()
      window.location.replace('/login')
    },
  })
}

export function useSessions() {
  return useQuery({
    queryKey: ['auth', 'sessions'],
    queryFn: async () => unwrap(await api.GET('/api/auth/sessions')),
  })
}

export function useRevokeSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.DELETE('/api/auth/sessions/{session_id}', { params: { path: { session_id: id } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['auth', 'sessions'] }),
  })
}

export const tokensKey = ['auth', 'tokens'] as const

/** API tokens: long-lived logins for the browser extension or another device. */
export function useTokens() {
  return useQuery({
    queryKey: tokensKey,
    queryFn: async () => unwrap(await api.GET('/api/auth/tokens')),
  })
}

/** Creating a token needs the password confirmed (it is a login until revoked). */
export function useCreateToken() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => withReauth(async () => unwrap(await api.POST('/api/auth/tokens', { body: { name } }))),
    onSuccess: () => qc.invalidateQueries({ queryKey: tokensKey }),
  })
}

export function useRevokeToken() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.DELETE('/api/auth/tokens/{token_id}', { params: { path: { token_id: id } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: tokensKey }),
  })
}
