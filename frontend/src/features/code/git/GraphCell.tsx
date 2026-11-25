/**
 * The graph part of one row of the Git view: the lines through the row and the commit's
 * dot (gitLanes.ts). Each row draws its own SVG of the row's height; the lines meet at
 * the row edges, so the rows together draw the whole graph.
 *
 * Lines that change lane bend with a bezier: into a dot they come down their lane and
 * turn in level with it; out of a dot (a merge's other parents) they leave level and
 * turn down into their lane. A merge commit is a hollow ring, HEAD has an accent ring.
 */
import { memo, useId } from 'react'
import { GRAPH_PAD, LANE_W, laneColor } from './gitFormat'
import type { LaneEdge, LaneRow } from './gitLanes'

const x = (lane: number) => GRAPH_PAD + lane * LANE_W

function topPath(e: LaneEdge, mid: number): string {
  if (e.from === e.to) return `M${x(e.from)} 0V${mid}`
  // Down its lane, then level into the dot.
  return `M${x(e.from)} 0C${x(e.from)} ${mid}, ${x(e.from)} ${mid}, ${x(e.to)} ${mid}`
}

function bottomPath(e: LaneEdge, mid: number, height: number): string {
  if (e.from === e.to) return `M${x(e.from)} ${mid}V${height}`
  // Level out of the dot, then down into its lane.
  return `M${x(e.from)} ${mid}C${x(e.to)} ${mid}, ${x(e.to)} ${mid}, ${x(e.to)} ${height}`
}

export const GraphCell = memo(function GraphCell({ row, width, height, head }: {
  row: LaneRow
  /** The graph column's width (graphWidth). */
  width: number
  height: number
  /** This is HEAD's commit. */
  head: boolean
}) {
  const id = useId()
  const mid = height / 2
  const cx = x(row.lane)
  const color = laneColor(row.color)
  const stub = Math.min(height - mid, 14)
  return (
    <svg aria-hidden="true" width={width} height={height} className="block shrink-0 overflow-hidden" style={{ minWidth: width }}>
      {row.bottom.some((e) => e.missing) && (
        <defs>
          {row.bottom.filter((e) => e.missing).map((e, i) => (
            <linearGradient key={i} id={`${id}-fade-${i}`} gradientUnits="userSpaceOnUse" x1="0" y1={mid} x2="0" y2={mid + stub}>
              <stop offset="0" style={{ stopColor: laneColor(e.color), stopOpacity: 0.9 }} />
              <stop offset="1" style={{ stopColor: laneColor(e.color), stopOpacity: 0 }} />
            </linearGradient>
          ))}
        </defs>
      )}
      <g fill="none" strokeWidth={2} strokeLinecap="round">
        {row.top.map((e, i) => <path key={`t${i}`} d={topPath(e, mid)} style={{ stroke: laneColor(e.color) }} />)}
        {row.bottom.filter((e) => !e.missing).map((e, i) => <path key={`b${i}`} d={bottomPath(e, mid, height)} style={{ stroke: laneColor(e.color) }} />)}
        {row.bottom.filter((e) => e.missing).map((e, i) => (
          <path key={`m${i}`} d={`M${x(e.from)} ${mid}V${mid + stub}`} strokeDasharray="2 3" stroke={`url(#${id}-fade-${i})`} />
        ))}
      </g>
      {head && <circle cx={cx} cy={mid} r={7.5} strokeWidth={2} style={{ stroke: 'var(--accent)', fill: 'var(--accent-soft)' }} />}
      {row.merge ? (
        <circle cx={cx} cy={mid} r={4} strokeWidth={2} style={{ stroke: color, fill: 'var(--surface)' }} />
      ) : (
        <circle cx={cx} cy={mid} r={head ? 4 : 3.75} style={{ fill: head ? 'var(--accent)' : color }} />
      )}
    </svg>
  )
})
