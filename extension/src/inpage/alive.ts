/**
 * Whether this script still belongs to a running extension. After the extension is
 * reloaded, updated or switched off, scripts it left in open pages keep running, but any
 * call into chrome.runtime throws "Extension context invalidated".
 */
export function extensionAlive(): boolean {
  try {
    return Boolean(chrome.runtime?.id)
  } catch {
    return false
  }
}

/** Runs `fn`; false if the extension is gone (or goes while it runs). */
export function whileAlive(fn: () => void): boolean {
  if (!extensionAlive()) return false
  try {
    fn()
    return true
  } catch {
    return false
  }
}
