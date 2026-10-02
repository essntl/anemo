import { createContext, useContext } from 'react'

/**
 * How long a closed dialog or notice may stay in the page to animate out before it is
 * removed regardless. Normally it is removed the moment its closing animation ends;
 * this is the safety net for when no animation runs (reduced motion, a hidden tab).
 */
export const EXIT_LIMIT_MS = 400

export interface Closing {
  /** True while what <Lingering> shows is on its way out. */
  closing: boolean
  /** Call when the closing animation has ended: removes it right away. */
  done: () => void
}

/** Set by <Lingering> (Lingering.tsx). */
export const ClosingContext = createContext<Closing>({ closing: false, done: () => undefined })

export function useClosing(): Closing {
  return useContext(ClosingContext)
}
