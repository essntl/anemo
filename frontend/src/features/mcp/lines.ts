/**
 * Text boxes with one entry per line, as used in the MCP server dialog:
 * headers ("Authorization: Bearer abc"), environment variables ("API_KEY=abc")
 * and command arguments.
 */

/** Lines of "name<separator>value" as an object. Blank lines and lines without the separator are skipped. */
export function parsePairs(text: string, separator: ':' | '='): Record<string, string> {
  const pairs: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const at = line.indexOf(separator)
    if (at <= 0) continue
    const name = line.slice(0, at).trim()
    if (name) pairs[name] = line.slice(at + 1).trim()
  }
  return pairs
}

/** Lines that have text but no "name<separator>value" shape (shown as a hint to fix them). */
export function badLines(text: string, separator: ':' | '='): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && line.indexOf(separator) <= 0)
}

/** One argument per line; blank lines are dropped. */
export function parseArgs(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * "npx -y @scope/server /data" pasted into the command box: the first word is the
 * program, the rest are arguments. (No quoting rules: use the arguments box for
 * arguments that contain spaces.)
 */
export function splitCommand(text: string): { command: string; args: string[] } {
  const [command = '', ...args] = text.trim().split(/\s+/)
  return { command, args }
}
