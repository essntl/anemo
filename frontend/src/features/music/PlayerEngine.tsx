import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTimerStore } from '@/features/focus/timerStore'
import { useSettings } from '@/features/settings/api'
import { musicKey } from './api'
import { onLibraryChanged, player, setPlayerPrefs, usePlayerStore } from './player/controller'
import { stopAfter, useSleepTimer } from './player/sleep'
import { useAmbient } from './player/ambient'
import { startExtensionBridge } from './extensionBridge'

/**
 * The music player's link to the rest of the app (mounted once, in PersistentLayer).
 * The player itself lives outside React (player/controller.ts) and its frames in a
 * hidden container that stays for the whole session, so pages can come and go.
 */
export function PlayerEngine() {
  const qc = useQueryClient()
  const music = useSettings().data?.music

  useEffect(() => {
    if (music) setPlayerPrefs({ trackAlerts: music.track_alerts, serverAudio: music.server_audio })
  }, [music])

  // Settings > Music, "Play while focusing": the music starts with a focus session and
  // pauses when it ends, is paused or a break begins. Only a change of the timer does
  // this (never just opening the app), so the buttons stay yours in between.
  const phase = useTimerStore((s) => s.timer.phase)
  const status = useTimerStore((s) => s.timer.status)
  const follow = music?.play_while_focusing ?? false
  const last = useRef<string | null>(null)
  useEffect(() => {
    const now = `${phase}:${status}`
    const before = last.current
    last.current = now
    if (!follow || before === null || before === now) return
    if (phase === 'focus' && status === 'running') player.play()
    else player.pause()
  }, [follow, phase, status])

  // "Stop after" (Music page): pause when the time is up.
  const until = useSleepTimer((s) => s.until)
  useEffect(() => {
    if (until === null) return
    const id = setTimeout(() => {
      player.pause()
      stopAfter(null)
    }, Math.max(0, until - Date.now()))
    return () => clearTimeout(id)
  }, [until])

  // Tracks saved to the library from here: refresh the lists that show them.
  useEffect(() => onLibraryChanged(() => void qc.invalidateQueries({ queryKey: musicKey })), [qc])

  // The browser extension's remote (play, pause, skip, add a link), if it is installed.
  useEffect(() => startExtensionBridge(), [])

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
