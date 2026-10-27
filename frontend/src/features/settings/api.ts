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

/** The sections that anyone signed in may change without confirming the password again. */
type PlainSection = 'focus' | 'music' | 'home' | 'files'

/**
 * Save one settings section. The cached settings update at once (optimistically), so
 * the change shows everywhere; a failed save puts the old value back.
 *
 *   const save = useSaveSection('focus')
 *   save.mutate({ ...focus, focus_minutes: 50 })
 */
export function useSaveSection<K extends PlainSection>(section: K) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (body: AllSettings[K]) => {
      // One PUT route per section; the path is checked by the generated types per call site.
      const put = api.PUT as unknown as (
        path: string,
        init: { body: AllSettings[K] },
      ) => Promise<{ data?: AllSettings[K]; error?: unknown; response: Response }>
      return unwrap(await put(`/api/settings/${section}`, { body }))
    },
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: settingsKey })
      const before = qc.getQueryData<AllSettings>(settingsKey)
      qc.setQueryData<AllSettings>(settingsKey, (old) => (old ? { ...old, [section]: body } : old))
      return { before }
    },
    onError: (_err, _body, context) => {
      if (context?.before) qc.setQueryData(settingsKey, context.before)
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: settingsKey }),
  })
}
