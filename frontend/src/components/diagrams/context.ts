import { createContext } from 'react'

export interface DiagramProblem {
  kind: 'mermaid' | 'chart'
  source: string
  error: string
}

/**
 * Set by a chat answer: asks the model to correct a diagram that can't be drawn. Where
 * there is no chat (a shared page, a document), it is absent and no button is shown.
 */
export const DiagramFixContext = createContext<((problem: DiagramProblem) => void) | null>(null)

/** The message sent for "Fix diagram". */
export function fixRequest({ kind, source, error }: DiagramProblem): string {
  const what = kind === 'chart' ? 'chart' : 'Mermaid diagram'
  const firstLine = source.trim().split('\n')[0]?.slice(0, 80) ?? ''
  return (
    `The ${what} in your answer can't be drawn` +
    (firstLine ? ` (it starts with \`${firstLine.replace(/`/g, "'")}\`)` : '') +
    `. The error was:\n\n> ${error.split('\n').join('\n> ')}\n\n` +
    `Please send the whole ${kind === 'chart' ? 'chart' : 'diagram'} again, corrected.`
  )
}
