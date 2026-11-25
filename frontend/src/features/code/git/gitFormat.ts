/** Small pure helpers of the Git view: short hashes, author initials and colours, lane colours. */

/** How many lane colours the theme defines (`--git-lane-1` … in styles/tokens.css). */
export const LANE_COLORS = 8

/** The theme colour of a lane's colour index. */
export const laneColor = (index: number): string => `var(--git-lane-${(((index % LANE_COLORS) + LANE_COLORS) % LANE_COLORS) + 1})`

/** "3f2a9c1" of a full hash. */
export const shortHash = (hash: string): string => hash.slice(0, 7)

/** "Artem Kotov" → "AK", "claude" → "CL", "" → "?". */
export function initials(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return [...words[0]].slice(0, 2).join('').toUpperCase()
  return ([...words[0]][0] + [...words[words.length - 1]][0]).toUpperCase()
}

/** A colour index for a name: the same name always gets the same colour. */
export function nameColor(name: string): number {
  let hash = 0
  for (const ch of name.trim().toLowerCase()) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  return hash % LANE_COLORS
}
