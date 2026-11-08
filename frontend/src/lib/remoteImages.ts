/**
 * Images in text written by a model or an agent (answers, documents, task notes) load by
 * themselves only from this app. Any other address waits for a click: loading it would
 * send that address, and whatever a prompt injection put into it, to another site
 * (refactor/BUGS.md sec-4).
 */
export function loadsWithoutAsking(src: string | null | undefined): boolean {
  if (!src) return true
  try {
    const url = new URL(src, window.location.href)
    return url.protocol === 'data:' || url.protocol === 'blob:' || url.origin === window.location.origin
  } catch {
    return false
  }
}

/** The host to name on the "Show image" button. */
export function imageHost(src: string): string {
  try {
    return new URL(src, window.location.href).host || src
  } catch {
    return src
  }
}
