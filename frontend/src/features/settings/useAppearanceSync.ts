import { useCallback, useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { type AllSettings, saveAppearance, settingsKey, useSettings } from './api'
import { currentAppearance, useThemeStore } from './theme'

// Once per page load, not per mount: the layout that uses this hook can be mounted again
// (e.g. after the full-screen browser on a phone), and loading the saved value again then
// would undo a change made since.
let hydrated = false

/**
 * Keeps the theme store and the server's appearance settings in sync:
 * loads the server value once, then saves user edits after a short pause.
 * With "Use a different appearance on this device" on, neither happens.
 */
export function useAppearanceSync() {
  const settings = useSettings()
  const qc = useQueryClient()
  const editVersion = useThemeStore((s) => s.editVersion)
  const deviceOnly = useThemeStore((s) => s.deviceOnly)
  const pending = useRef(false)

  useEffect(() => {
    if (settings.data && !hydrated) {
      hydrated = true
      if (!useThemeStore.getState().deviceOnly) useThemeStore.getState().hydrate(settings.data.appearance)
    }
  }, [settings.data])

  const save = useCallback(() => {
    pending.current = false
    if (useThemeStore.getState().deviceOnly) return
    saveAppearance(currentAppearance())
      .then((appearance) =>
        qc.setQueryData<AllSettings>(settingsKey, (old) => (old ? { ...old, appearance } : old)),
      )
      .catch(() => {
        // Appearance still applies locally; it will be retried on the next edit.
      })
  }, [qc])

  useEffect(() => {
    if (editVersion === 0 || deviceOnly) return
    pending.current = true
    const timer = window.setTimeout(save, 500)
    return () => window.clearTimeout(timer)
  }, [editVersion, deviceOnly, save])

  // Leaving before the pause is over: save now rather than never.
  useEffect(() => () => {
    if (pending.current) save()
  }, [save])
}

/** For tests: forget that the saved value was loaded. */
export function resetAppearanceSync() {
  hydrated = false
}
