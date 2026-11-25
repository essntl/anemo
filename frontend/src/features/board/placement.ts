/** Where a card lands on a board, as the order of a column's ids (pure, no React). */

/** The ids of a column after `id` is put in front of `before` (or at the end). */
export function orderAfterMove(ids: string[], id: string, before: string | null): string[] {
  const rest = ids.filter((x) => x !== id)
  const at = before ? rest.indexOf(before) : -1
  rest.splice(at < 0 ? rest.length : at, 0, id)
  return rest
}
