import { describe, expect, it } from 'vitest'
import { type LaneCommit, type LaneRow, layoutLanes } from './gitLanes'

/** Commits from "hash:parent,parent" strings, newest first. */
const log = (...lines: string[]): LaneCommit[] =>
  lines.map((line) => {
    const [hash, parents = ''] = line.split(':')
    return { hash, parents: parents ? parents.split(',') : [] }
  })

const row = (rows: LaneRow[], hash: string) => rows.find((r) => r.hash === hash)!
const curves = (edges: LaneRow['top']) => edges.filter((e) => e.from !== e.to)

describe('layoutLanes', () => {
  it('keeps a linear history in one lane, one colour', () => {
    const { rows, lanes } = layoutLanes(log('d:c', 'c:b', 'b:a', 'a'))
    expect(lanes).toBe(1)
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0, 0])
    expect(new Set(rows.map((r) => r.color)).size).toBe(1)
    expect(rows[0].tip).toBe(true)
    expect(rows[0].top).toEqual([])
    expect(rows[1].top).toEqual([{ from: 0, to: 0, color: 0 }])
    expect(rows[3].bottom).toEqual([]) // the root: nothing below it
  })

  it('draws a branch and its merge with curves out of and into the main line', () => {
    // m merges feature (f2, f1) into main (b); both started from a.
    const { rows, lanes } = layoutLanes(log('m:b,f2', 'f2:f1', 'b:a', 'f1:a', 'a'))
    expect(lanes).toBe(2)
    const m = row(rows, 'm')
    expect(m.merge).toBe(true)
    expect(m.lane).toBe(0)
    expect(curves(m.bottom)).toEqual([{ from: 0, to: 1, color: row(rows, 'f2').color }])
    expect(row(rows, 'f2').lane).toBe(1)
    expect(row(rows, 'f1').lane).toBe(1)
    expect(row(rows, 'b').lane).toBe(0)
    // a: the feature's line ends in it, curving in from lane 1.
    const a = row(rows, 'a')
    expect(a.lane).toBe(0)
    expect(curves(a.top)).toEqual([{ from: 1, to: 0, color: row(rows, 'f1').color }])
    expect(row(rows, 'f2').color).not.toBe(m.color)
  })

  it('lays out an octopus merge: one curve per extra parent, each in a lane of its own', () => {
    const { rows, lanes } = layoutLanes(log('o:a,b,c,d', 'a:r', 'b:r', 'c:r', 'd:r', 'r'))
    const o = row(rows, 'o')
    expect(o.merge).toBe(true)
    expect(curves(o.bottom).map((e) => e.to)).toEqual([1, 2, 3])
    expect(new Set(curves(o.bottom).map((e) => e.color)).size).toBe(3)
    expect(['a', 'b', 'c', 'd'].map((h) => row(rows, h).lane)).toEqual([0, 1, 2, 3])
    expect(lanes).toBe(4)
    // All four lines meet again in r.
    expect(curves(row(rows, 'r').top).map((e) => e.from)).toEqual([1, 2, 3])
  })

  it('gives many parallel branches a lane each and frees them when they end', () => {
    const tips = Array.from({ length: 12 }, (_, i) => `t${i}:base`)
    const { rows, lanes } = layoutLanes(log(...tips, 'base:root', 'root'))
    expect(lanes).toBe(12)
    expect(rows.slice(0, 12).map((r) => r.lane)).toEqual([...Array(12).keys()])
    expect(new Set(rows.slice(0, 12).map((r) => r.color)).size).toBe(12)
    // base: every line ends in it; below it only one lane is left.
    expect(row(rows, 'base').lane).toBe(0)
    expect(curves(row(rows, 'base').top)).toHaveLength(11)
    expect(row(rows, 'base').bottom).toEqual([{ from: 0, to: 0, color: row(rows, 'base').color }])
    expect(row(rows, 'root').width).toBe(1)
  })

  it('reuses a freed lane, leftmost first', () => {
    // x's line ends at its root; y starts after that and takes the free lane 1.
    const { rows } = layoutLanes(log('a:b', 'x', 'b:c', 'y:c', 'c'))
    expect(row(rows, 'x').lane).toBe(1)
    expect(row(rows, 'b').lane).toBe(0)
    expect(row(rows, 'y').lane).toBe(1)
    expect(row(rows, 'y').color).not.toBe(row(rows, 'x').color)
  })

  it('draws a fading stub for parents that are not in the list, and keeps no lane for them', () => {
    // The history was cut: b's parent and m's second parent aren't loaded.
    const { rows } = layoutLanes(log('m:a,gone2', 'a:b', 'b:gone1'))
    const m = row(rows, 'm')
    expect(m.bottom.filter((e) => e.missing)).toHaveLength(1)
    const b = row(rows, 'b')
    expect(b.bottom).toEqual([{ from: 0, to: 0, color: b.color, missing: true }])
    // No lane waits for gone2: a and b stay alone in lane 0.
    expect(row(rows, 'a').top).toEqual([{ from: 0, to: 0, color: m.color }])
    expect(row(rows, 'a').width).toBe(1)
  })

  it('places a missing first parent without letting another parent take its lane', () => {
    const { rows } = layoutLanes(log('m:gone,p', 'p'))
    const m = row(rows, 'm')
    expect(m.bottom.find((e) => e.missing)).toMatchObject({ from: 0, to: 0 })
    expect(curves(m.bottom)).toEqual([{ from: 0, to: 1, color: row(rows, 'p').color }])
  })

  it('gives a detached HEAD that is on no branch a lane of its own', () => {
    // HEAD (h) was committed on top of an older commit (b) while main moved on (c).
    const { rows } = layoutLanes(log('h:b', 'c:b', 'b:a', 'a'))
    expect(row(rows, 'h')).toMatchObject({ lane: 0, tip: true })
    expect(row(rows, 'c')).toMatchObject({ lane: 1, tip: true })
    expect(row(rows, 'b').lane).toBe(0)
    expect(curves(row(rows, 'b').top)).toEqual([{ from: 1, to: 0, color: row(rows, 'c').color }])
  })

  it('keeps the colour of a line for as long as it goes on', () => {
    const { rows } = layoutLanes(log('m2:m1,f3', 'f3:f2', 'm1:m0', 'f2:f1', 'f1:m0', 'm0'))
    const main = ['m2', 'm1', 'm0'].map((h) => row(rows, h))
    const feature = ['f3', 'f2', 'f1'].map((h) => row(rows, h))
    expect(new Set(main.map((r) => r.color)).size).toBe(1)
    expect(new Set(main.map((r) => r.lane)).size).toBe(1)
    expect(new Set(feature.map((r) => r.color)).size).toBe(1)
    expect(new Set(feature.map((r) => r.lane)).size).toBe(1)
    // The lines in between carry the same colour as the dots of their line.
    for (const r of rows.slice(1, -1)) {
      const through = r.top.find((e) => e.from === row(rows, 'f3').lane && e.to === e.from)
      if (through && r.lane !== through.from) expect(through.color).toBe(feature[0].color)
    }
  })

  it('is deterministic', () => {
    const commits = log('o:a,b,c', 'a:r', 'b:x', 'c:r', 'x:r', 'r')
    expect(layoutLanes(commits)).toEqual(layoutLanes(commits.map((c) => ({ ...c }))))
  })

  it('handles an empty list', () => {
    expect(layoutLanes([])).toEqual({ rows: [], lanes: 0 })
  })
})
