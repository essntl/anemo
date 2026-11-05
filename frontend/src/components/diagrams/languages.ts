/** Code block languages drawn as pictures instead of shown as code. */
export const DIAGRAM_LANGUAGES = ['mermaid', 'chart'] as const
export type DiagramLanguage = (typeof DIAGRAM_LANGUAGES)[number]

export function isDiagramLanguage(lang: string | null | undefined): lang is DiagramLanguage {
  return (DIAGRAM_LANGUAGES as readonly string[]).includes(lang ?? '')
}
