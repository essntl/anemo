/**
 * The lanes of a git graph (the Code page's Git view): where each commit's dot goes and
 * which lines run through its row. Pure: the same commits always give the same layout.
 *
 * The commits come newest first in topological order (`git log --topo-order`), so every
 * commit is listed before its parents. Walking down the list, each lane "waits for" one
 * commit, the next one of its line:
 *
 *  - a commit that some lanes wait for takes the leftmost of them; the others end in it
 *    (the lines of branches that forked off here curve into the dot);
 *  - a commit no lane waits for (a branch tip, a detached HEAD) starts a lane of its own,
 *    in the leftmost free slot, with a new colour;
 *  - its first parent continues in the commit's lane, with the same colour: a line keeps
 *    its lane and its colour for as long as it goes on;
 *  - every other parent (a merge, an octopus merge) joins the lane that already waits for
 *    it, or starts a new lane with a new colour, reached by a curve from the dot;
 *  - a parent that isn't in the list (the history was cut at `limit`) gets a short line
 *    down that fades out, and no lane: nothing would ever arrive to end it.
 *
 * A lane whose line has ended is free and is used again by the next line that needs one,
 * leftmost first, so the graph stays as narrow as it can.
 *
 * Each row's lines are split at the dot: `top` from the top of the row to its middle,
 * `bottom` from the middle to the bottom. A line that passes through goes from lane j to
 * lane j in both halves; one that bends goes from one lane to another (drawn as a curve).
 */

/** A commit as the layout needs it. */
export interface LaneCommit {
  hash: string
  parents: readonly string[]
}

/** One line in one half of a row, from a lane (at the half's top) to a lane (at its bottom). */
export interface LaneEdge {
  from: number
  to: number
  /** The colour index of the line (GraphCell.tsx turns it into a palette colour). */
  color: number
  /** Runs to a parent that isn't in the list: drawn short, fading out. */
  missing?: boolean
}

/** One commit's row. */
export interface LaneRow {
  hash: string
  /** The lane of the commit's dot. */
  lane: number
  /** The colour index of the dot (and of its line). */
  color: number
  /** Two parents or more. */
  merge: boolean
  /** No lane waited for it: the start of a line (a branch tip, a detached HEAD). */
  tip: boolean
  /** From the top of the row to the dot (or straight through). */
  top: LaneEdge[]
  /** From the dot (or straight through) to the bottom of the row. */
  bottom: LaneEdge[]
  /** How many lanes this row uses (the highest lane + 1 of everything in it). */
  width: number
}

export interface LaneLayout {
  rows: LaneRow[]
  /** The widest row: how many lanes the graph needs. */
  lanes: number
}

interface Lane {
  /** The commit this lane waits for. */
  hash: string
  color: number
}

/** Lays out the commits (newest first, in topological order). */
export function layoutLanes(commits: readonly LaneCommit[]): LaneLayout {
  const listed = new Set(commits.map((c) => c.hash))
  const lanes: (Lane | null)[] = []
  let nextColor = 0
  let widest = 0
  const rows: LaneRow[] = []

  const freeSlot = (): number => {
    const at = lanes.indexOf(null)
    if (at >= 0) return at
    lanes.push(null)
    return lanes.length - 1
  }

  for (const commit of commits) {
    // The lanes that wait for this commit, left to right.
    const waiting: number[] = []
    lanes.forEach((lane, i) => {
      if (lane?.hash === commit.hash) waiting.push(i)
    })
    const tip = waiting.length === 0
    const lane = tip ? freeSlot() : waiting[0]
    const color = tip ? nextColor++ : (lanes[lane] as Lane).color

    // Top half: lines that pass through, and those that end in the dot.
    const top: LaneEdge[] = []
    lanes.forEach((l, i) => {
      if (!l) return
      top.push({ from: i, to: l.hash === commit.hash ? lane : i, color: l.color })
    })
    for (const i of waiting) lanes[i] = null

    // Bottom half: the parents.
    const bottom: LaneEdge[] = []
    const seen = new Set<string>()
    // Lanes that start at this dot (a merge's other parents): no line above their curve.
    const started = new Set<number>()
    // Held while the parents are placed, so no other parent's lane starts under the dot.
    const HOLD: Lane = { hash: '', color }
    lanes[lane] = HOLD
    commit.parents.forEach((parent, index) => {
      if (seen.has(parent)) return
      seen.add(parent)
      if (!listed.has(parent)) {
        bottom.push({ from: lane, to: lane, color: index === 0 ? color : nextColor++, missing: true })
        return
      }
      if (index === 0) {
        // The line goes on in this lane (another lane may wait for the same parent: the
        // two meet in the parent's row).
        lanes[lane] = { hash: parent, color }
        return
      }
      const joins = lanes.findIndex((l) => l?.hash === parent)
      if (joins >= 0) {
        bottom.push({ from: lane, to: joins, color: (lanes[joins] as Lane).color })
        return
      }
      const slot = freeSlot()
      const newColor = nextColor++
      lanes[slot] = { hash: parent, color: newColor }
      started.add(slot)
      bottom.push({ from: lane, to: slot, color: newColor })
    })
    if (lanes[lane] === HOLD) lanes[lane] = null
    // Every lane still waiting goes straight down (the first parent's too).
    lanes.forEach((l, i) => {
      if (l && !started.has(i)) bottom.push({ from: i, to: i, color: l.color })
    })
    // Sorted: the straight lines first, so the curves are drawn over them.
    bottom.sort((a, b) => Number(a.from !== a.to) - Number(b.from !== b.to) || a.from - b.from || a.to - b.to)
    top.sort((a, b) => Number(a.from !== a.to) - Number(b.from !== b.to) || a.from - b.from)

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop()

    let width = lane + 1
    for (const e of [...top, ...bottom]) width = Math.max(width, e.from + 1, e.to + 1)
    widest = Math.max(widest, width)
    rows.push({ hash: commit.hash, lane, color, merge: commit.parents.length > 1, tip, top, bottom, width })
  }

  return { rows, lanes: widest }
}
