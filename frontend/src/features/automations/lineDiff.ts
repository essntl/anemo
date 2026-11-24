/**
 * A line-by-line diff of two texts, for reviewing a script's change: every line of the
 * old and the new code, marked as kept, removed or added (the longest common
 * subsequence of lines, so moved blocks show as a removal and an addition).
 */
export interface DiffLine {
  kind: 'same' | 'removed' | 'added'
  text: string
}

/** Above this many lines on both sides together, the table would be too big: then every
 * old line is shown as removed and every new one as added. */
const MAX_LINES = 4000

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  if (a.length + b.length > MAX_LINES) {
    return [...a.map((text) => ({ kind: 'removed' as const, text })), ...b.map((text) => ({ kind: 'added' as const, text }))]
  }
  // common[i][j]: how many lines a[i..] and b[j..] have in common, in order.
  const common: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i][j] = a[i] === b[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1])
    }
  }
  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'same', text: a[i] })
      i++
      j++
    } else if (common[i + 1][j] >= common[i][j + 1]) {
      lines.push({ kind: 'removed', text: a[i++] })
    } else {
      lines.push({ kind: 'added', text: b[j++] })
    }
  }
  while (i < a.length) lines.push({ kind: 'removed', text: a[i++] })
  while (j < b.length) lines.push({ kind: 'added', text: b[j++] })
  return lines
}

/** What was added to and taken out of a list (tools, hosts, secrets). */
export function listDiff(before: string[], after: string[]): { added: string[]; removed: string[]; kept: string[] } {
  return {
    added: after.filter((x) => !before.includes(x)),
    removed: before.filter((x) => !after.includes(x)),
    kept: after.filter((x) => before.includes(x)),
  }
}
