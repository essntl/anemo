import { useEffect } from 'react'
import { TimerEngine } from '@/features/focus/TimerEngine'
import { PlayerEngine } from '@/features/music/PlayerEngine'
import { player } from '@/features/music/player/controller'
import { useOffPages } from '@/features/settings/navigation'

/**
 * What keeps running while you move between pages: the focus timer's clock, the
 * music player (its hidden player frames) and the Dynamic Island. Mounted once in
 * AppLayout and never loaded lazily, so music and the timer carry on across
 * navigation. Each engine below renders nothing visible except the Island.
 */
export function PersistentLayer() {
  // Music turned off (Settings > Pages): no player, and what was playing stops.
  const music = !useOffPages().includes('music')
  useEffect(() => {
    if (!music) player.pause()
  }, [music])
  return (
    <>
      <TimerEngine />
      {music && <PlayerEngine />}
    </>
  )
}
