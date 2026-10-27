import { TimerEngine } from '@/features/focus/TimerEngine'

/**
 * What keeps running while you move between pages: the focus timer's clock, the
 * music player (its hidden player frames) and the Dynamic Island. Mounted once in
 * AppLayout and never loaded lazily, so music and the timer carry on across
 * navigation. Each engine below renders nothing visible except the Island.
 */
export function PersistentLayer() {
  return (
    <>
      <TimerEngine />
    </>
  )
}
