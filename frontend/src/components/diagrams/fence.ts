/**
 * Whether a fenced code block is complete. While an answer is still being written, the
 * Markdown parser treats a block without its closing fence as running to the end of the
 * text; such a block is shown as code and only drawn once its closing fence arrived.
 */

/** Strips what may stand in front of a line inside a list or quote: spaces and `>`. */
const PREFIX = /^[\s>]*/

/**
 * True when `raw` (the block's Markdown source, from its opening fence on) ends with a
 * closing fence of the same kind and at least the same length. Indented code blocks
 * have no fences and are always complete.
 */
export function isFenceClosed(raw: string): boolean {
  const lines = raw.replace(/\s+$/, '').split('\n')
  const open = /^(`{3,}|~{3,})/.exec(lines[0].replace(PREFIX, ''))
  if (!open) return true
  if (lines.length < 2) return false
  const close = /^(`{3,}|~{3,})\s*$/.exec(lines[lines.length - 1].replace(PREFIX, ''))
  return Boolean(close && close[1][0] === open[1][0] && close[1].length >= open[1].length)
}
