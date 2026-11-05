/**
 * Math is written `$…$` (inline) and `$$…$$` (display). Ordinary text uses `$` too
 * ("$5 and $10", "$5-$10"), and the Markdown math parser would turn that into a formula.
 * Before parsing, every single `$` that can't be one end of a formula is escaped (`\$`),
 * much like Pandoc: an opening `$` has a non-space right after it, the closing one is the
 * next `$`, with a non-space right before it and no digit right after it.
 *
 * Code (fenced blocks and inline code spans) is left untouched, and so is `$$`.
 */

const FENCE = /^[\s>]*(`{3,}|~{3,})/

export function protectDollars(markdown: string): string {
  if (!markdown.includes('$')) return markdown
  let fence: string | null = null
  return markdown
    .split('\n')
    .map((line) => {
      const f = FENCE.exec(line)
      if (fence) {
        if (f && f[1][0] === fence[0] && f[1].length >= fence.length && /^[\s>]*[`~]+\s*$/.test(line)) fence = null
        return line
      }
      if (f) {
        fence = f[1]
        return line
      }
      return protectLine(line)
    })
    .join('\n')
}

/** One line outside code blocks: its inline code spans are kept as they are. */
function protectLine(line: string): string {
  if (!line.includes('$')) return line
  let out = ''
  let i = 0
  const span = /(`+)[\s\S]*?\1/g
  for (let m = span.exec(line); m; m = span.exec(line)) {
    out += protectText(line.slice(i, m.index)) + m[0]
    i = m.index + m[0].length
  }
  return out + protectText(line.slice(i))
}

function escaped(text: string, at: number): boolean {
  let n = 0
  for (let k = at - 1; k >= 0 && text[k] === '\\'; k--) n++
  return n % 2 === 1
}

const space = (c: string | undefined) => c === undefined || /\s/.test(c)

/** Escapes the single `$` signs in plain text that don't pair up into a formula. */
function protectText(text: string): string {
  if (!text.includes('$')) return text
  // Positions of single dollars (not part of `$$`, not already escaped).
  const singles: number[] = []
  for (let k = 0; k < text.length; k++) {
    if (text[k] !== '$' || escaped(text, k)) continue
    if (text[k + 1] === '$') {
      k++ // `$$`: display math, left as it is
      continue
    }
    singles.push(k)
  }
  // A formula can't contain a single `$`, so it closes at the next one, if that one can
  // close it; otherwise the `$` is text.
  const keep = new Set<number>()
  for (let a = 0; a + 1 < singles.length; a++) {
    const open = singles[a]
    const close = singles[a + 1]
    if (space(text[open + 1]) || space(text[close - 1]) || /\d/.test(text[close + 1] ?? '')) continue
    keep.add(open)
    keep.add(close)
    a++
  }
  let out = ''
  let last = 0
  for (const k of singles) {
    if (keep.has(k)) continue
    out += text.slice(last, k) + '\\$'
    last = k + 1
  }
  return out + text.slice(last)
}
