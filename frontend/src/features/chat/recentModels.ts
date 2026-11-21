/** The models chosen last in the message box, newest first, kept in this browser. */
const KEY = 'anemo.chat.recentModels'
const KEEP = 6

export function recentModels(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return [] // no storage, or not ours
  }
}

export function rememberModel(id: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([id, ...recentModels().filter((m) => m !== id)].slice(0, KEEP)))
  } catch {
    // no storage: the list is only a convenience
  }
}

/**
 * The few models to show first, out of `usable`: the one in use, the default, then the
 * ones chosen last, filled up from the start of the list.
 */
export function shortlist<T extends { id: string }>(usable: T[], current: string | null, fallback: string | null, size = 4): T[] {
  const wanted = [current, fallback, ...recentModels(), ...usable.map((m) => m.id)]
  const picked: T[] = []
  for (const id of wanted) {
    const model = usable.find((m) => m.id === id)
    if (model && !picked.includes(model)) picked.push(model)
    if (picked.length === size) break
  }
  // In the order of the full list, so a model is always found in the same place.
  return usable.filter((m) => picked.includes(m))
}
