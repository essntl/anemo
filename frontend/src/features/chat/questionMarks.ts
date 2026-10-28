import type { QuestionMark } from './api'

export type AnswerPart = { kind: 'text'; text: string } | { kind: 'question'; mark: QuestionMark }

/** Where to cut the text for a question: the paragraph break nearest to `at` (the
 *  text before and after an answered question are separate paragraphs), not before
 *  the previous cut. */
function cutAt(text: string, at: number, from: number): number {
  if (at <= from) return from
  if (at >= text.length) return text.length
  let best = -1
  for (let i = text.indexOf('\n\n', from); i !== -1; i = text.indexOf('\n\n', i + 1)) {
    if (best === -1 || Math.abs(i - at) < Math.abs(best - at)) best = i
    if (i > at) break
  }
  return best === -1 ? at : best
}

/** The answer's text with the agent's questions (and the user's answers) put back
 *  where the agent stopped to ask them. */
export function splitAtQuestions(text: string, marks: QuestionMark[] | undefined): AnswerPart[] {
  const parts: AnswerPart[] = []
  let from = 0
  for (const mark of [...(marks ?? [])].sort((a, b) => a.at - b.at)) {
    const cut = cutAt(text, mark.at, from)
    const before = text.slice(from, cut).trim()
    if (before) parts.push({ kind: 'text', text: before })
    parts.push({ kind: 'question', mark })
    from = cut
  }
  const rest = text.slice(from).trim()
  if (rest || parts.length === 0) parts.push({ kind: 'text', text: rest })
  return parts
}
