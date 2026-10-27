/** The focus timer's sounds (files in public/sounds). Missing audio never breaks the timer. */

export type Chime = 'bell' | 'soft' | 'none'
type Sound = 'chime' | 'start' | 'reset'

const FILES: Record<Exclude<Chime, 'none'>, string> = { bell: '/sounds/timer.mp3', soft: '/sounds/toggle.mp3' }

export function playSound(sound: Sound, chime: Chime, volume: number): void {
  if (chime === 'none' || volume <= 0) return
  const src = sound === 'chime' ? FILES[chime] : sound === 'start' ? '/sounds/start.mp3' : '/sounds/reset.mp3'
  try {
    const audio = new Audio(src)
    audio.volume = Math.min(1, Math.max(0, volume))
    void audio.play().catch(() => undefined) // autoplay refused, or no audio device
  } catch {
    // audio is not available here (tests, some embedded browsers)
  }
}
