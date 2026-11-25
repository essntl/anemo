/**
 * The card → page transition of Settings > Plugins: the card you click grows into the
 * plugin's page, and shrinks back into its card when you go back.
 *
 * Three ways, picked once per navigation (`transitionMode`):
 *
 *  - `view-transition` (browsers with `document.startViewTransition`): React Router starts
 *    a view transition for the navigation (app/router.tsx turns it on for every link). The
 *    clicked card and the page's sheet carry the same `view-transition-name` (`HERO`), and
 *    so do the icon and the name, so the browser morphs one into the other. Only the
 *    clicked card gets the names (two elements with one name would cancel the transition):
 *    `useHeroStore` remembers which plugin that is, and the list gives the names to that
 *    card alone. The page's own cross-fade (`.page` in app.css) is tuned while it runs
 *    (transition.css), so the two don't fight.
 *  - `layout` (no View Transitions API): the same idea with `motion`'s shared layout
 *    animation: card and sheet share a `layoutId`, and motion animates the difference with
 *    transforms (FLIP).
 *  - `none` (the system asks for less motion): the page simply appears.
 *
 * The sheet draws at once with the card's data (api.ts seeds the detail query from the
 * list), so the morph never lands on a loading state.
 */
import type { CSSProperties } from 'react'
import { create } from 'zustand'
import './transition.css'

export type TransitionMode = 'view-transition' | 'layout' | 'none'

/** The view-transition-names of the shared elements (fixed: only one card has them at a time). */
export const HERO = 'plugin-hero'
export const HERO_ICON = 'plugin-hero-icon'
export const HERO_NAME = 'plugin-hero-name'
/** Set on <html> while a plugin transition runs (transition.css keys off it). */
export const RUNNING_CLASS = 'plugin-vt'
/** Longer than the longest animation in transition.css. */
export const RUNNING_MS = 700

interface ViewTransitionDocument {
  startViewTransition?: unknown
}

/** How the next card ↔ page change animates in this browser. */
export function transitionMode(win: Window = window): TransitionMode {
  if (win.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return 'none'
  if (typeof (win.document as ViewTransitionDocument).startViewTransition === 'function') return 'view-transition'
  return 'layout'
}

/** Which plugin's card is the shared element right now (the one last opened). */
export const useHeroStore = create<{ id: string | null }>(() => ({ id: null }))

/**
 * Get ready to open (or go back from) a plugin's page: remember the card, and mark the
 * document so the page cross-fade steps aside for the morph. Returns the options for
 * `navigate` (`viewTransition` only where the browser has it).
 */
export function beginPluginTransition(id: string, win: Window = window): { viewTransition: boolean } {
  useHeroStore.setState({ id })
  const mode = transitionMode(win)
  if (mode === 'view-transition') {
    const root = win.document.documentElement
    root.classList.add(RUNNING_CLASS)
    win.setTimeout(() => root.classList.remove(RUNNING_CLASS), RUNNING_MS)
  }
  return { viewTransition: mode === 'view-transition' }
}

/**
 * The style that makes an element one of the shared ones, or nothing. `on`: this is the
 * clicked card (or the page of that plugin); `name`: which part (HERO, HERO_ICON, HERO_NAME).
 */
export function heroStyle(on: boolean, name: string, mode: TransitionMode): CSSProperties | undefined {
  return on && mode === 'view-transition' ? ({ viewTransitionName: name } as CSSProperties) : undefined
}

/** The `layoutId` for motion's fallback, only when the View Transitions API is missing. */
export function heroLayoutId(id: string, part: 'card' | 'icon' | 'name', mode: TransitionMode): string | undefined {
  return mode === 'layout' ? `plugin-${part}-${id}` : undefined
}
