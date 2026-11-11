import { createContext } from 'react'
import { t } from '@/lib/i18n'

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
  const start = (source.trim().split('\n')[0]?.slice(0, 80) ?? '').replace(/`/g, "'")
  const quoted = error.split('\n').join('\n> ')
  if (kind === 'chart') {
    return start
      ? t("The chart in your answer can't be drawn (it starts with `{start}`). The error was:\n\n> {error}\n\nPlease send the whole chart again, corrected.", { start, error: quoted })
      : t("The chart in your answer can't be drawn. The error was:\n\n> {error}\n\nPlease send the whole chart again, corrected.", { error: quoted })
  }
  return start
    ? t("The Mermaid diagram in your answer can't be drawn (it starts with `{start}`). The error was:\n\n> {error}\n\nPlease send the whole diagram again, corrected.", { start, error: quoted })
    : t("The Mermaid diagram in your answer can't be drawn. The error was:\n\n> {error}\n\nPlease send the whole diagram again, corrected.", { error: quoted })
}
