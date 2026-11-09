/**
 * Sites the panel may read without a click first (question 48, a1): after you clicked the
 * toolbar icon (or a right-click entry, or a shortcut) on a tab, the panel offers "Always
 * allow on <site>", which asks Chrome for that one site. Settings lists them, to remove.
 */

/** The access pattern for one site (scheme and host, any path), or null if not a web page. */
export function originPattern(url: string | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return `${u.protocol}//${u.hostname}/*`
  } catch {
    return null
  }
}

/** "https://example.com/*" → "example.com" (for showing). */
export function siteName(pattern: string): string {
  return pattern.replace(/^[a-z*]+:\/\//, '').replace(/\/\*$/, '').replace(/^www\./, '')
}

/**
 * Of every site access the extension holds, the ones given with "Always allow": exact
 * http(s) sites, not the Anemo address and not YouTube while notes are on (those belong to
 * their features). Focus sites use `*://` patterns, so they aren't listed here.
 */
export function rememberedSites(origins: string[], anemoUrl: string | null, youtubeNotes: boolean): string[] {
  const anemo = originPattern(anemoUrl ?? undefined)
  return origins
    .filter((o) => /^https?:\/\/[^*/]+\/\*$/.test(o))
    .filter((o) => o !== anemo && !(youtubeNotes && o === 'https://www.youtube.com/*'))
    .sort((a, b) => siteName(a).localeCompare(siteName(b)))
}
