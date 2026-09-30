import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas, unwrap } from '@/api/client'

export type AllSettings = Schemas['AllSettings']
export const settingsKey = ['settings'] as const

export function useSettings() {
  return useQuery({
    queryKey: settingsKey,
    queryFn: async () => unwrap(await api.GET('/api/settings')),
  })
}

export function useSaveGeneral() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (body: Schemas['GeneralSettings']) =>
      unwrap(await api.PUT('/api/settings/general', { body })),
    onSuccess: (general) =>
      qc.setQueryData<AllSettings>(settingsKey, (old) => (old ? { ...old, general } : old)),
  })
}

export async function saveAppearance(body: Schemas['AppearanceSettings']) {
  return unwrap(await api.PUT('/api/settings/appearance', { body }))
}
