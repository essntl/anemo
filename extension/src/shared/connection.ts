/** The saved connection to an Anemo server, and helpers for its address. */

export interface Connection {
  /** The server's origin, e.g. https://ai.example.com (no trailing slash, no path). */
  serverUrl: string
  /** The API token; null after it was found revoked (the setup screen asks for a new one). */
  token: string | null
  username: string | null
  /** Why the token is gone, shown on the setup screen. */
  lostReason: 'revoked' | null
  connectedAt: string
}

export type ParsedUrl = { ok: true; url: string; insecure: boolean } | { ok: false; error: string }

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[^.]+\.local|[^.]+)$/i

/**
 * Turns what was typed into the server's origin. "ai.example.com" becomes
 * "https://ai.example.com". Anemo is served at the root of its address, so a path is
 * an error rather than silently dropped.
 */
export function parseServerUrl(input: string): ParsedUrl {
  let text = input.trim()
  if (!text) return { ok: false, error: 'Enter the address you open Anemo at.' }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { ok: false, error: 'That is not a web address.' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: 'The address must start with https:// (or http:// on your own network).' }
  }
  if (url.username || url.password) return { ok: false, error: 'Leave the user name and password out of the address.' }
  const path = url.pathname.replace(/\/+$/, '')
  if (path && path !== '') {
    return { ok: false, error: 'Use the address without a path, e.g. https://ai.example.com (Anemo runs at the root).' }
  }
  if (url.protocol === 'http:' && !LOCAL_HOST.test(url.hostname)) {
    return { ok: false, error: 'Use https:// for an address on the internet: the token would travel unencrypted.' }
  }
  return { ok: true, url: url.origin, insecure: url.protocol === 'http:' }
}

/** The host permission pattern for the server, e.g. https://ai.example.com/* */
export function originPattern(serverUrl: string): string {
  return `${new URL(serverUrl).origin}/*`
}
