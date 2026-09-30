import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas, unwrap } from '@/api/client'
import { withReauth } from '@/features/auth/reauthStore'
import { settingsKey } from '@/features/settings/api'

export type Provider = Schemas['ProviderOut']
export type Model = Schemas['ModelOut']
export type ProviderIn = Schemas['ProviderIn']
export type ProviderPatch = Schemas['ProviderPatch']
export type ModelDefaults = Schemas['ModelDefaults']

const providersKey = ['providers'] as const
const modelsKey = ['models'] as const
const setupKey = ['setup-status'] as const

export function useProviderTypes() {
  return useQuery({
    queryKey: ['provider-types'],
    queryFn: async () => unwrap(await api.GET('/api/provider-types')),
    staleTime: Infinity,
  })
}

export function useProviders() {
  return useQuery({ queryKey: providersKey, queryFn: async () => unwrap(await api.GET('/api/providers')) })
}

export function useModels() {
  return useQuery({ queryKey: modelsKey, queryFn: async () => unwrap(await api.GET('/api/models')) })
}

export function useSetupStatus() {
  return useQuery({ queryKey: setupKey, queryFn: async () => unwrap(await api.GET('/api/setup/status')) })
}

/** Invalidate everything that depends on providers/models after a change. */
function useRefresh() {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: providersKey })
    void qc.invalidateQueries({ queryKey: modelsKey })
    void qc.invalidateQueries({ queryKey: setupKey })
  }
}

// Provider changes are security-sensitive: the server may ask for the password again.

export function useCreateProvider() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: (body: ProviderIn) =>
      withReauth(async () => unwrap(await api.POST('/api/providers', { body }))),
    onSuccess: refresh,
  })
}

export function useUpdateProvider() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ProviderPatch }) =>
      withReauth(async () =>
        unwrap(await api.PATCH('/api/providers/{provider_id}', { params: { path: { provider_id: id } }, body })),
      ),
    onSuccess: refresh,
  })
}

export function useDeleteProvider() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: (id: string) =>
      withReauth(async () =>
        unwrap(await api.DELETE('/api/providers/{provider_id}', { params: { path: { provider_id: id } } })),
      ),
    onSuccess: refresh,
  })
}

export function useTestProvider() {
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.POST('/api/providers/{provider_id}/test', { params: { path: { provider_id: id } } })),
  })
}

export function useDiscover(providerId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['discover', providerId],
    enabled,
    retry: false,
    staleTime: 60_000,
    queryFn: async () =>
      unwrap(await api.GET('/api/providers/{provider_id}/discover', { params: { path: { provider_id: providerId } } })),
  })
}

export function useImportModels() {
  const refresh = useRefresh()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ providerId, keys }: { providerId: string; keys: string[] }) =>
      unwrap(
        await api.POST('/api/providers/{provider_id}/models/import', {
          params: { path: { provider_id: providerId } },
          body: { model_keys: keys },
        }),
      ),
    onSuccess: (_, { providerId }) => {
      refresh()
      void qc.invalidateQueries({ queryKey: ['discover', providerId] })
    },
  })
}

export function useCreateModel() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async (body: Schemas['ModelIn']) => unwrap(await api.POST('/api/models', { body })),
    onSuccess: refresh,
  })
}

export function useUpdateModel() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async ({ id, body }: { id: string; body: Schemas['ModelPatch'] }) =>
      unwrap(await api.PATCH('/api/models/{model_id}', { params: { path: { model_id: id } }, body })),
    onSuccess: refresh,
  })
}

export function useDeleteModel() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.DELETE('/api/models/{model_id}', { params: { path: { model_id: id } } })),
    onSuccess: refresh,
  })
}

export function useTestModel() {
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.POST('/api/models/{model_id}/test', { params: { path: { model_id: id } } })),
  })
}

export function useSaveModelDefaults() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (body: ModelDefaults) => unwrap(await api.PUT('/api/settings/models', { body })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: settingsKey })
      void qc.invalidateQueries({ queryKey: setupKey })
    },
  })
}
