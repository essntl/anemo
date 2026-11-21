/** The word list as typed in Settings → Dictation: one name or term per line (commas work too). */
export function parseVocabulary(text: string): string[] {
  const words = text.split(/[\n,]/).map((w) => w.trim().slice(0, 80)).filter(Boolean)
  return [...new Set(words)].slice(0, 200)
}
