import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas, unwrap } from '@/api/client'
import { settingsKey } from '@/features/settings/api'

export type VoiceSettings = Schemas['VoiceSettings']

/** Save Settings → Voice. */
export function useSaveVoiceSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (body: VoiceSettings) => unwrap(await api.PUT('/api/settings/voice', { body })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: settingsKey }),
  })
}
