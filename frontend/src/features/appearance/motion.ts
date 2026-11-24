/** When an animated background may move (AppBackground.tsx). */
import { useSyncExternalStore } from 'react'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import type { Background } from './apply'

export const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'
export const PHONE = '(pointer: coarse), (max-width: 767px)'

function subscribeVisibility(onChange: () => void) {
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}

/** False while the tab is in the background (another tab, a minimised window, a locked phone). */
export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, () => document.visibilityState !== 'hidden')
}

/** Should an animated background stand still now? */
export function useStill(background: Background): boolean {
  const reduced = useMediaQuery(REDUCED_MOTION)
  const phone = useMediaQuery(PHONE)
  return reduced || (phone && !background.animate_on_phones)
}
