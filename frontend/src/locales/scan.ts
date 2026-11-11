/**
 * Finds the texts the source marks for translation: the first argument of `t(…)`,
 * `msg(…)` and `rich(…)`, and both forms of `plural(count, one, other)`. Used by
 * locales.test.ts; only plain string literals are found, which is why i18n.tsx asks for them.
 */
const STRING = String.raw`'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|` + '`(?:[^`\\\\$]|\\\\.)*`'
const SINGLE = new RegExp(String.raw`(?<![\w.$])(?:t|msg|rich)\(\s*(${STRING})`, 'g')
const PLURAL = new RegExp(String.raw`(?<![\w.$])plural\(\s*[^,]+?,\s*(${STRING})\s*,\s*(${STRING})`, 'g')

/** The value of a string literal as written in the source. */
function unquote(literal: string): string {
  const body = literal.slice(1, -1)
  return body.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r?\n|.)/g, (_, esc: string) => {
    if (esc === 'n') return '\n'
    if (esc === 't') return '\t'
    if (esc.startsWith('u{')) return String.fromCodePoint(parseInt(esc.slice(2, -1), 16))
    if (esc.startsWith('u') || esc.startsWith('x')) return String.fromCodePoint(parseInt(esc.slice(1), 16))
    if (esc.endsWith('\n')) return ''
    return esc
  })
}

export function keysIn(source: string): string[] {
  const keys: string[] = []
  for (const m of source.matchAll(SINGLE)) keys.push(unquote(m[1]))
  for (const m of source.matchAll(PLURAL)) keys.push(`${unquote(m[1])} | ${unquote(m[2])}`)
  return keys
}
