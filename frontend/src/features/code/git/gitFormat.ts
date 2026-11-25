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

/** The width of a lane in the graph, and the space left of the first one (GraphCell.tsx). */
export const LANE_W = 13
export const GRAPH_PAD = 10
/** Lanes drawn at most: a wider graph is cut at the right (the rows stay readable). */
export const MAX_LANES = 18

/** How wide the graph column is for a graph of `lanes` lanes. */
export const graphWidth = (lanes: number) => GRAPH_PAD * 2 + (Math.min(Math.max(lanes, 1), MAX_LANES) - 1) * LANE_W

/** A colour of the theme as a pill's text, background and border (RefPills.tsx). */
export function tinted(color: string, strong = false): { color: string; backgroundColor: string; borderColor: string } {
  return {
    color: `color-mix(in oklch, ${color}, var(--text) 38%)`,
    backgroundColor: `color-mix(in oklch, ${color} ${strong ? 22 : 12}%, transparent)`,
    borderColor: `color-mix(in oklch, ${color} ${strong ? 55 : 30}%, transparent)`,
  }
}
