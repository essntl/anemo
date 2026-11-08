import { useCallback, useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { type AllSettings, saveAppearance, settingsKey, useSettings } from './api'
import { useThemeStore } from './theme'

// Once per page load, not per mount: the layout that uses this hook can be mounted again
// (e.g. after the full-screen browser on a phone), and loading the saved value again then
// would undo a change made since.
let hydrated = false

/**
 * Keeps the theme store and the server's appearance settings in sync:
 * loads the server value once, then saves user edits after a short pause.
 */
export function useAppearanceSync() {
  const settings = useSettings()
  const qc = useQueryClient()
  const editVersion = useThemeStore((s) => s.editVersion)
  const pending = useRef(false)

  useEffect(() => {
    if (settings.data && !hydrated) {
      hydrated = true
      useThemeStore.getState().hydrate(settings.data.appearance)
    }
  }, [settings.data])

  const save = useCallback(() => {
    pending.current = false
    const { mode, accent, density } = useThemeStore.getState()
    saveAppearance({ mode, accent, density })
      .then((appearance) =>
        qc.setQueryData<AllSettings>(settingsKey, (old) => (old ? { ...old, appearance } : old)),
      )
      .catch(() => {
        // Appearance still applies locally; it will be retried on the next edit.
      })
  }, [qc])

  useEffect(() => {
    if (editVersion === 0) return
    pending.current = true
    const timer = window.setTimeout(save, 500)
    return () => window.clearTimeout(timer)
  }, [editVersion, save])

  // Leaving before the pause is over: save now rather than never.
  useEffect(() => () => {
    if (pending.current) save()
  }, [save])
}

/** For tests: forget that the saved value was loaded. */
export function resetAppearanceSync() {
  hydrated = false
}
