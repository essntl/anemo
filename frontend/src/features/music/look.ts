/**
 * The look of the "now playing" panel, worked out from the track itself: a gradient in
 * the track's own hue and the bars of its scrubber. Both come from a hash of the track,
 * so a track always looks the same, and nothing is decoded or measured: no reading of
 * the cover image (which another site serves and the page may not read), no audio analysis.
 */

/** A small stable hash of a text (FNV-1a), as an unsigned 32-bit number. */
function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * A dark gradient in the track's hue, for white text on top (every stop is at most 36%
 * light). Without a track: the app's accent, darkened.
 */
export function trackGradient(seed: string | null | undefined): string {
  if (!seed) return 'linear-gradient(165deg, color-mix(in oklch, var(--accent), black 62%), color-mix(in oklch, var(--accent), black 30%))'
  const hue = hash(seed) % 360
  return `linear-gradient(165deg, hsl(${hue} 55% 16%) 0%, hsl(${(hue + 22) % 360} 58% 30%) 55%, hsl(${(hue + 58) % 360} 52% 34%) 100%)`
}

/** The heights (0.2 to 1) of the scrubber's bars: the same for a track every time. */
export function waveform(seed: string | null | undefined, bars: number): number[] {
  let state = hash(seed || 'anemo') || 1
  const next = () => {
    // xorshift32
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0xffffffff
  }
  const out: number[] = []
  let level = 0.6
  for (let i = 0; i < bars; i++) {
    // Each bar stays near the one before it, so the row reads as a wave and not as noise.
    level = Math.min(1, Math.max(0.2, level + (next() - 0.5) * 0.7))
    out.push(Math.round(level * 100) / 100)
  }
  return out
}
