import { useEffect, useRef } from 'react'
import { useSettings, saveAppearance } from './api'
import { useThemeStore } from './theme'

/**
 * Keeps the theme store and the server's appearance settings in sync:
 * loads the server value once, then saves user edits after a short pause.
 */
export function useAppearanceSync() {
  const settings = useSettings()
  const hydrated = useRef(false)
  const editVersion = useThemeStore((s) => s.editVersion)

  useEffect(() => {
    if (settings.data && !hydrated.current) {
      hydrated.current = true
      useThemeStore.getState().hydrate(settings.data.appearance)
    }
  }, [settings.data])

  useEffect(() => {
    if (editVersion === 0) return
    const timer = window.setTimeout(() => {
      const { mode, accent, density } = useThemeStore.getState()
      saveAppearance({ mode, accent, density }).catch(() => {
        // Appearance still applies locally; it will be retried on the next edit.
      })
    }, 500)
    return () => window.clearTimeout(timer)
  }, [editVersion])
}
