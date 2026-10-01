/**
 * Desktop notifications from the browser, shown while this tab is in the
 * background. They are a per-device choice (kept in this browser, not on the
 * server) and need the browser's permission. They only work while a tab with
 * the app is open; for anything else, use a Discord destination.
 */

const STORAGE_KEY = 'anemo.desktopNotifications'

export type DesktopSupport = 'ok' | 'unsupported' | 'insecure' | 'blocked'

/** Whether this browser can show desktop notifications, and if not, why. */
export function desktopSupport(): DesktopSupport {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported'
  if (!window.isSecureContext) return 'insecure' // browsers require HTTPS (or localhost)
  if (Notification.permission === 'denied') return 'blocked'
  return 'ok'
}

export function desktopEnabled(): boolean {
  try {
    return (
      desktopSupport() === 'ok' &&
      Notification.permission === 'granted' &&
      localStorage.getItem(STORAGE_KEY) === 'on'
    )
  } catch {
    return false // storage is not available (private mode)
  }
}

/** Turn them on (asks the browser for permission) or off. Returns the new state. */
export async function setDesktopEnabled(on: boolean): Promise<boolean> {
  if (!on) {
    localStorage.removeItem(STORAGE_KEY)
    return false
  }
  if (desktopSupport() !== 'ok') return false
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
  if (permission !== 'granted') return false
  localStorage.setItem(STORAGE_KEY, 'on')
  return true
}

/** Show one, if they are on and the tab is in the background. Returns whether it was shown. */
export function showDesktopNotification(
  note: { id: string; title: string; body: string },
  onClick: () => void,
): boolean {
  if (!desktopEnabled() || !document.hidden) return false
  try {
    // `tag` makes several open tabs show it once instead of once per tab.
    const popup = new Notification(note.title, { body: note.body, tag: note.id })
    popup.onclick = () => {
      window.focus()
      onClick()
      popup.close()
    }
    return true
  } catch {
    return false // e.g. Android Chrome only allows notifications from a service worker
  }
}
