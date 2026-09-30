import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, unwrap } from '@/api/client'

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
    onSettled: () => {
      qc.clear()
      qc.setQueryData(meKey, null)
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
