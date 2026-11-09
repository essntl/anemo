import { useCallback } from 'react'
import { withDefaults, type Preferences } from '@/shared/preferences'
import { storage } from '@/shared/storage'
import { useStored } from './useStored'

export function usePreferences(): { prefs: Preferences; loaded: boolean; update: (fn: (p: Preferences) => Preferences) => Promise<void> } {
  const { value, loaded } = useStored('local', 'preferences')
  const prefs = withDefaults(value)
  const update = useCallback(async (fn: (p: Preferences) => Preferences) => {
    const current = withDefaults(await storage.get('local', 'preferences'))
    await storage.set('local', 'preferences', fn(current))
    void chrome.runtime.sendMessage({ type: 'features.changed' }).catch(() => undefined)
  }, [])
  return { prefs, loaded, update }
}
