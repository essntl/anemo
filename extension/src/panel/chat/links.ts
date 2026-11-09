/** Absolute links only; a path is a page of Anemo and opens there. */
export function resolveHref(href: string | undefined, serverUrl: string): string | undefined {
  if (!href) return undefined
  if (href.startsWith('/') && !href.startsWith('//')) return `${serverUrl}${href}`
  try {
    const url = new URL(href)
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : undefined
  } catch {
    return undefined
  }
}
