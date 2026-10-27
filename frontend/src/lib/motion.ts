/**
 * Shared spring settings for the few places that animate with `motion` (the Dynamic
 * Island, the home widget grid, reordering the music queue, the Segmented control).
 * Everything else uses the CSS classes in styles/app.css.
 *
 * Reduced motion: <MotionConfig reducedMotion="user"> (main.tsx) turns movement and
 * layout animations off for people who asked their system for less motion; opacity
 * still fades, so shapes cross-fade instead of morphing.
 */
import type { Transition } from 'motion/react'

export const spring = {
  /** Small controls: a pressed button, the Segmented indicator. */
  snappy: { type: 'spring', stiffness: 520, damping: 38, mass: 0.7 },
  /** Lists and cards settling into place. */
  smooth: { type: 'spring', stiffness: 320, damping: 34, mass: 0.9 },
  /** The Island changing shape. */
  island: { type: 'spring', stiffness: 380, damping: 30, mass: 0.9 },
} satisfies Record<string, Transition>

/** A short fade, used where a spring would only add movement. */
export const fade: Transition = { duration: 0.16, ease: [0.22, 1, 0.36, 1] }
