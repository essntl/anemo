/**
 * This browser tab's id and "someone is using it" reports. Agent tools that act in
 * the browser (start the focus timer, queue music) act in the open tab used most
 * recently (see backend app/events/presence.py), so they don't fire on the phone and
 * the desktop at once.
 */
import { api } from '@/api/client'

let id: string | null = null

export function tabId(): string {
  if (id) return id
  try {
    id = sessionStorage.getItem('anemo.tab')
  } catch {
    id = null
  }
  if (!id) {
    id = (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Math.random()).slice(2)).replace(/[^A-Za-z0-9_-]/g, '')
    try {
      sessionStorage.setItem('anemo.tab', id)
    } catch {
      // no storage: a new id per page load is fine
    }
  }
  return id
}

let last = 0
/** Tell the server this tab is in use (at most every 30 seconds). */
export function reportUse(force = false): void {
  if (document.visibilityState !== 'visible') return
  const now = Date.now()
  if (!force && now - last < 30_000) return
  last = now
  void api.POST('/api/presence', { body: { tab: tabId() } }).catch(() => undefined)
}

/** Report use on load, when the tab comes to the front, and while someone clicks or types. */
export function watchUse(): () => void {
  reportUse(true)
  const onVisible = () => document.visibilityState === 'visible' && reportUse(true)
  const onUse = () => reportUse()
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('pointerdown', onUse, { passive: true })
  window.addEventListener('keydown', onUse)
  return () => {
    document.removeEventListener('visibilitychange', onVisible)
    window.removeEventListener('pointerdown', onUse)
    window.removeEventListener('keydown', onUse)
  }
}
