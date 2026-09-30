import { useSyncExternalStore } from 'react'

/** True while the CSS media query matches, e.g. useMediaQuery('(min-width: 768px)'). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    () => window.matchMedia(query).matches,
  )
}

/** The `md` breakpoint: from here up the app uses its desktop layout. */
export const DESKTOP = '(min-width: 768px)'
