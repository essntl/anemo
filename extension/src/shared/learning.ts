/**
 * Learning actions on a page (feature 4): each starts a new chat in Anemo with the page
 * attached, in plain chat mode (no tools), and the panel shows it streaming.
 */
import { unwrap, type Api } from './api'
import type { PageContext } from './pageContext'

export type LearningAction = 'summarize' | 'quiz'

export const PROMPTS: Record<LearningAction, string> = {
  summarize:
    'Summarize the attached page. Start with a short TL;DR (one or two sentences), then the key points as a list. ' +
    'Fit the length to the page: a short article gets a few points, a long or dense one more.',
  quiz:
    'Quiz me on the attached page. Ask 5 questions in total, one at a time, mixing multiple-choice and short-answer questions, ' +
    'about what matters most on the page. After each question, wait for my answer, then grade it (correct, partly correct or wrong), ' +
    'explain briefly and give the right answer, and ask the next question. After the fifth, sum up how I did and what to review.',
}

export function pageForApi(page: PageContext) {
  return { url: page.url, title: page.title, source: page.source, content: page.content, truncated: page.truncated }
}

/** Creates the chat and sends the request; returns the chat's id. */
export async function startLearningChat(api: Api, page: PageContext, action: LearningAction): Promise<string> {
  const conv = unwrap(await api.POST('/api/conversations', { body: { temporary: false } }))
  unwrap(
    await api.POST('/api/conversations/{conversation_id}/turns', {
      params: { path: { conversation_id: conv.id } },
      body: { text: PROMPTS[action], mode: 'chat', page: pageForApi(page), attachment_ids: [], reference_ids: [] },
    }),
  )
  return conv.id
}

/** The draft for "Discuss in chat": the selection, quoted. */
export function discussDraft(selection: string): string {
  const text = selection.trim()
  if (!text) return ''
  const quoted = text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
  return `${quoted}\n\n`
}
