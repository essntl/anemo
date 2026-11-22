/** A whole number kept within its limits (an empty or odd entry becomes the lowest). */
export function clampInt(text: string, min: number, max: number): number {
  const n = Math.round(Number(text))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min
}
