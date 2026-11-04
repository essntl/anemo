import { useEffect } from 'react'
import { useNavigate } from 'react-router'

/** A path inside the app, never another site. */
export function isAppPath(path: unknown): path is string {
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//')
}

/**
 * Tapping a push notification while a tab is open: the service worker focuses that
 * tab and asks it to show the page, which then opens without a reload.
 */
export function useServiceWorkerLinks() {
  const navigate = useNavigate()
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; path?: unknown } | null
      if (data?.type === 'anemo.navigate' && isAppPath(data.path)) void navigate(data.path)
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [navigate])
}
