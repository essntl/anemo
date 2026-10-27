import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useSettings } from '@/features/settings/api'
import { musicKey } from './api'
import { onLibraryChanged, setPlayerPrefs, usePlayerStore } from './player/controller'
import { useAmbient } from './player/ambient'

/**
 * The music player's link to the rest of the app (mounted once, in PersistentLayer).
 * The player itself lives outside React (player/controller.ts) and its frames in a
 * hidden container that stays for the whole session, so pages can come and go.
 */
export function PlayerEngine() {
  const qc = useQueryClient()
  const music = useSettings().data?.music

  useEffect(() => {
    if (music) setPlayerPrefs({ trackAlerts: music.track_alerts })
  }, [music])

  // Tracks saved to the library from here: refresh the lists that show them.
  useEffect(() => onLibraryChanged(() => void qc.invalidateQueries({ queryKey: musicKey })), [qc])

  // Another tab on this device changed the queue or volume.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'anemo-player') void usePlayerStore.persist.rehydrate()
      if (e.key === 'anemo-ambient') void useAmbient.persist.rehydrate()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])
  return null
}
