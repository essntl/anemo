/**
 * Some models write citations in a private markup (invisible characters U+E200, U+E202,
 * U+E201 around e.g. "cite", "turn0search3"). Anemo turns them into links once an answer
 * is complete; while it is still streaming they are hidden (as in Anemo's
 * frontend/src/lib/citations.ts).
 */
const MARKUP = /[^]*/g
const DANGLING = /[^]*$/
const STRAY = /[-]/g

export function stripCitationMarkup(text: string): string {
  if (!/[-]/.test(text)) return text
  return text.replace(MARKUP, '').replace(DANGLING, '').replace(STRAY, '')
}
