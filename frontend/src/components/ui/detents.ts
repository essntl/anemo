/** The heights a DetentSheet rests at, and where it goes when let go (DetentSheet.tsx). */

/** How much of the screen the sheet may take when pulled all the way up. */
export const MAX_PART = 0.92
/** A finger moving faster than this (px per ms) when it lets go is a flick. */
const FLICK = 0.45
/** Two heights closer than this (px) are one: everything fits at the first. */
export const SAME = 24

/** Where the sheet rests after being let go at `height`, moving at `velocity` (px/ms, down is positive). */
export function restingPlace(
  { height, velocity, from }: { height: number; velocity: number; from: 'half' | 'full' },
  half: number,
  full: number,
): 'closed' | 'half' | 'full' {
  const two = full - half > SAME
  if (velocity > FLICK) return from === 'full' && two ? 'half' : 'closed'
  if (velocity < -FLICK) return two ? 'full' : 'half'
  if (height < half * 0.6) return 'closed'
  if (!two) return 'half'
  return height > (half + full) / 2 ? 'full' : 'half'
}
