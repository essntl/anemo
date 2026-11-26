/** Where a card lands on a board, as the order of a column's ids (pure, no React). */

/** The ids of a column after `id` is put in front of `before` (or at the end). */
export function orderAfterMove(ids: string[], id: string, before: string | null): string[] {
  const rest = ids.filter((x) => x !== id)
  const at = before ? rest.indexOf(before) : -1
  rest.splice(at < 0 ? rest.length : at, 0, id)
  return rest
}

/**
 * The whole column's order after a move, when the board shows only some of its cards
 * (a filter hides the others). `shown` is the order of the cards on the board after
 * the move; the hidden ones keep their places, and `id` goes in front of the card it
 * was dropped before, or right after the one it follows (at the end when the column
 * shows nothing else).
 */
export function mergeIntoFull(full: string[], shown: string[], id: string): string[] {
  const rest = full.filter((x) => x !== id)
  const at = shown.indexOf(id)
  const next = shown[at + 1]
  const prev = shown[at - 1]
  if (next !== undefined && rest.includes(next)) rest.splice(rest.indexOf(next), 0, id)
  else if (prev !== undefined && rest.includes(prev)) rest.splice(rest.indexOf(prev) + 1, 0, id)
  else rest.push(id)
  return rest
}

/** Where a picked-up card goes with an arrow key: a column, and the card it goes in front of. */
export interface Slot {
  column: number
  /** Position in the column, counted without the card itself (0: at the top). */
  index: number
}

/**
 * One arrow key's step for a card picked up with the keyboard. `sizes` is how many
 * other cards each column has (the picked-up one not counted); `ordered` whether a
 * column can be put in order (a column that sorts itself only takes a card at the end).
 */
export function stepSlot(slot: Slot, key: string, sizes: number[], ordered: boolean[]): Slot {
  const last = sizes.length - 1
  const clampIn = (column: number, index: number) => ({ column, index: ordered[column] ? Math.max(0, Math.min(index, sizes[column])) : sizes[column] })
  switch (key) {
    case 'ArrowLeft': return slot.column > 0 ? clampIn(slot.column - 1, slot.index) : slot
    case 'ArrowRight': return slot.column < last ? clampIn(slot.column + 1, slot.index) : slot
    case 'ArrowUp': return ordered[slot.column] ? clampIn(slot.column, slot.index - 1) : slot
    case 'ArrowDown': return ordered[slot.column] ? clampIn(slot.column, slot.index + 1) : slot
    default: return slot
  }
}
